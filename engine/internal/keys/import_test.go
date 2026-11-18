package keys

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/pem"
	"errors"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// A real key file of each kind, written the way OpenSSH writes them, so these tests are against the files a
// person actually has and not against a shape invented here.
func keyFile(t *testing.T, kind string, passphrase string) ([]byte, ssh.PublicKey) {
	t.Helper()
	var priv any
	switch kind {
	case "ed25519":
		_, k, err := ed25519.GenerateKey(rand.Reader)
		must(t, err)
		priv = k
	case "rsa2048":
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		must(t, err)
		priv = k
	case "rsa1024":
		k, err := rsa.GenerateKey(rand.Reader, 1024)
		must(t, err)
		priv = k
	case "ecdsa256":
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		must(t, err)
		priv = k
	case "ecdsa384":
		k, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
		must(t, err)
		priv = k
	case "ecdsa521":
		k, err := ecdsa.GenerateKey(elliptic.P521(), rand.Reader)
		must(t, err)
		priv = k
	default:
		t.Fatalf("no such kind: %s", kind)
	}
	var block *pem.Block
	var err error
	if passphrase == "" {
		block, err = ssh.MarshalPrivateKey(priv, "")
	} else {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(priv, "", []byte(passphrase))
	}
	must(t, err)
	signer, err := ssh.NewSignerFromKey(priv)
	must(t, err)
	return pem.EncodeToMemory(block), signer.PublicKey()
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestAKeyFileBroughtInSignsForItsBox(t *testing.T) {
	for _, kind := range []string{"ed25519", "rsa2048", "ecdsa256"} {
		t.Run(kind, func(t *testing.T) {
			file, pub := keyFile(t, kind, "")
			l := New()
			info, err := l.TakeKey("b1", "b1", "demo", file, nil, time.Now())
			must(t, err)

			// The list holds the very key that was in the file: its public half is the file's own.
			want := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub)))
			if info.PublicKey != want {
				t.Fatalf("the key brought in is not the one in the file:\n got %s\nwant %s", info.PublicKey, want)
			}
			if info.Origin != OriginImported {
				t.Fatalf("origin is %q, not %q", info.Origin, OriginImported)
			}
			if info.Type != pub.Type() {
				t.Fatalf("type is %q, not %q", info.Type, pub.Type())
			}

			// And it signs a real sign-in, which verifies under that same public half.
			for _, alg := range signsWith[pub.Type()] {
				r := request{session: bytes.Repeat([]byte{7}, 32), kind: 50, hasSig: 1, user: "demo", service: "ssh-connection", method: "publickey", alg: alg, blob: pub.Marshal()}
				data := r.bytes()
				raw, err := l.Sign("b1", "b1", alg, data)
				must(t, err)
				var sig ssh.Signature
				must(t, ssh.Unmarshal(raw, &sig))
				if sig.Format != alg {
					t.Fatalf("signed as %q, asked for %q", sig.Format, alg)
				}
				if err := pub.Verify(data, &sig); err != nil {
					t.Fatalf("the signature does not verify under the file's own key (%s): %v", alg, err)
				}
			}
		})
	}
}

func TestAKeyFileWithAPassphrase(t *testing.T) {
	file, pub := keyFile(t, "ed25519", "a real passphrase")
	l := New()

	// With none: said as needing one, and nothing is kept.
	if _, err := l.TakeKey("b1", "b1", "demo", file, nil, time.Now()); !errors.Is(err, ErrNeedsPassphrase) {
		t.Fatalf("with no passphrase the error is %v, not ErrNeedsPassphrase", err)
	}
	if len(l.Keys()) != 0 {
		t.Fatal("a refused key file left a key in the list")
	}

	// With the wrong one: told apart from every other refusal, and still nothing is kept.
	if _, err := l.TakeKey("b1", "b1", "demo", file, []byte("not it"), time.Now()); !errors.Is(err, ErrWrongPassphrase) {
		t.Fatalf("with the wrong passphrase the error is %v, not ErrWrongPassphrase", err)
	}
	if len(l.Keys()) != 0 {
		t.Fatal("a refused key file left a key in the list")
	}

	// With the right one: in, and it is the file's own key.
	info, err := l.TakeKey("b1", "b1", "demo", file, []byte("a real passphrase"), time.Now())
	must(t, err)
	if info.PublicKey != strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))) {
		t.Fatal("the key brought in is not the one in the file")
	}
}

func TestWhatMayNotBeBroughtIn(t *testing.T) {
	l := New()
	now := time.Now()
	small, _ := keyFile(t, "rsa1024", "")
	good, _ := keyFile(t, "ed25519", "")

	cases := []struct {
		what string
		file []byte
		want error
	}{
		{"nothing at all", nil, ErrBadKeyFile},
		{"a public key, not a private one", ssh.MarshalAuthorizedKey(mustPub(t, good)), ErrBadKeyFile},
		{"some other text", []byte("-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n"), ErrBadKeyFile},
		{"an RSA key below 2048 bits", small, ErrKeyTooSmall},
		{"a file larger than any real key", bytes.Repeat([]byte("x"), maxKeyFile+1), ErrBadKeyFile},
	}
	for _, c := range cases {
		t.Run(c.what, func(t *testing.T) {
			if _, err := l.TakeKey("b1", "b1", "demo", c.file, nil, now); !errors.Is(err, c.want) {
				t.Fatalf("the error is %v, not %v", err, c.want)
			}
			if len(l.Keys()) != 0 {
				t.Fatal("a refused key file left a key in the list")
			}
		})
	}
}

func mustPub(t *testing.T, file []byte) ssh.PublicKey {
	t.Helper()
	k, err := ssh.ParseRawPrivateKey(file)
	must(t, err)
	s, err := ssh.NewSignerFromKey(k)
	must(t, err)
	return s.PublicKey()
}

// A key brought in may not be asked to sign with an algorithm its kind is not allowed: ssh-rsa is SHA-1 and is
// refused however it is asked for.
func TestAKeyOnlySignsWithWhatItsKindAllows(t *testing.T) {
	file, pub := keyFile(t, "rsa2048", "")
	l := New()
	_, err := l.TakeKey("b1", "b1", "demo", file, nil, time.Now())
	must(t, err)
	for _, alg := range []string{ssh.KeyAlgoRSA, ssh.KeyAlgoED25519, "rsa-sha2-512-cert-v01@openssh.com", ""} {
		r := request{session: bytes.Repeat([]byte{7}, 32), kind: 50, hasSig: 1, user: "demo", service: "ssh-connection", method: "publickey", alg: alg, blob: pub.Marshal()}
		if _, err := l.Sign("b1", "b1", alg, r.bytes()); err == nil {
			t.Fatalf("a key signed with %q, which its kind does not allow", alg)
		}
	}
}

// A list changed from outside cannot make a key of one kind sign as another.
func TestAKeyThatLiesAboutItsKindCannotSign(t *testing.T) {
	file, _ := keyFile(t, "rsa2048", "")
	l := New()
	_, err := l.TakeKey("b1", "b1", "demo", file, nil, time.Now())
	must(t, err)
	l.keys["b1"].Type = ssh.KeyAlgoED25519
	if _, err := l.Sign("b1", "b1", ssh.KeyAlgoED25519, []byte("anything")); err == nil {
		t.Fatal("a key whose kind was changed from outside still signed")
	}
	if line := l.Keys()[0].PublicKey; line != "" {
		t.Fatalf("a key whose kind was changed still showed a public half: %s", line)
	}
}

// Both halves of a key are never set at once, whatever a changed list says. The request here is a real one, so
// the only thing that can refuse it is that rule: a request that is wrong in some other way would make this
// test pass whether the rule is there or not.
func TestAKeyWithBothHalvesIsRefused(t *testing.T) {
	file, pub := keyFile(t, "ed25519", "")
	l := New()
	_, err := l.TakeKey("b1", "b1", "demo", file, nil, time.Now())
	must(t, err)
	r := request{session: bytes.Repeat([]byte{7}, 32), kind: 50, hasSig: 1, user: "demo", service: "ssh-connection", method: "publickey", alg: ssh.KeyAlgoED25519, blob: pub.Marshal()}

	// First: with one half only, that very request is signed. So what follows can fail for one reason alone.
	if _, err := l.Sign("b1", "b1", ssh.KeyAlgoED25519, r.bytes()); err != nil {
		t.Fatalf("the request this test rests on is not signable: %v", err)
	}
	l.keys["b1"].Seed = bytes.Repeat([]byte{7}, ed25519.SeedSize)
	if _, err := l.Sign("b1", "b1", ssh.KeyAlgoED25519, r.bytes()); err == nil {
		t.Fatal("a key holding both a seed and a brought-in key still signed")
	}
}

// Reading a key file keeps nothing: the list it is read into is thrown away, and the real list is untouched.
func TestReadingAKeyFileKeepsNothing(t *testing.T) {
	file, pub := keyFile(t, "ed25519", "")
	line, kind, err := TryKeyFile(file, nil)
	must(t, err)
	if line != strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))) {
		t.Fatal("the key read is not the one in the file")
	}
	if kind != ssh.KeyAlgoED25519 {
		t.Fatalf("kind is %q", kind)
	}

	// A file with a passphrase is told apart before anything is committed.
	withPass, _ := keyFile(t, "ed25519", "secret enough")
	if _, _, err := TryKeyFile(withPass, nil); !errors.Is(err, ErrNeedsPassphrase) {
		t.Fatalf("the error is %v, not ErrNeedsPassphrase", err)
	}
	if _, _, err := TryKeyFile(withPass, []byte("secret enough")); err != nil {
		t.Fatalf("the right passphrase did not open the file: %v", err)
	}
}
