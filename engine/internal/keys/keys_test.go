package keys

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/lab/hostile"
	"sshapp/engine/internal/link"
	"sshapp/engine/internal/vault"
)

var (
	cheap = vault.Params{Time: vault.MinTime, MemoryKiB: vault.MinMemoryKiB, Threads: 2}
	pw    = []byte("a long enough password")
	t0    = time.Date(2026, 11, 16, 3, 0, 0, 0, time.UTC)
)

func str(s []byte) []byte {
	out := make([]byte, 4+len(s))
	binary.BigEndian.PutUint32(out, uint32(len(s)))
	copy(out[4:], s)
	return out
}

// request builds what a client signs for a public-key sign-in, with any field changed by the caller.
type request struct {
	session                    []byte
	kind, hasSig               byte
	user, service, method, alg string
	blob                       []byte
	extra                      []byte
}

func (r request) bytes() []byte {
	var b []byte
	b = append(b, str(r.session)...)
	b = append(b, r.kind)
	b = append(b, str([]byte(r.user))...)
	b = append(b, str([]byte(r.service))...)
	b = append(b, str([]byte(r.method))...)
	b = append(b, r.hasSig)
	b = append(b, str([]byte(r.alg))...)
	b = append(b, str(r.blob)...)
	return append(b, r.extra...)
}

func honest(t testing.TB, info Info) request {
	t.Helper()
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(info.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	return request{session: bytes.Repeat([]byte{7}, 32), kind: 50, hasSig: 1, user: info.User, service: "ssh-connection", method: "publickey", alg: "ssh-ed25519", blob: pub.Marshal()}
}

func TestAKeySignsItsOwnBoxsSignInAndNothingElse(t *testing.T) {
	l := New()
	a, err := l.NewKey("k1", "box-a", "demo", t0)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := l.NewKey("k2", "box-b", "demo", t0)
	pubA, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(a.PublicKey))

	good := honest(t, a)
	raw, err := l.Sign("k1", "box-a", "ssh-ed25519", good.bytes())
	if err != nil {
		t.Fatal(err)
	}
	sig := new(ssh.Signature)
	if err := ssh.Unmarshal(raw, sig); err != nil || pubA.Verify(good.bytes(), sig) != nil {
		t.Fatal("the signature does not verify under the key's public half")
	}

	if _, err := l.Sign("k1", "box-b", "ssh-ed25519", good.bytes()); !errors.Is(err, ErrNotThisBox) {
		t.Fatalf("box-a's key asked for by box-b: %v", err)
	}
	if _, err := l.Sign("k9", "box-a", "ssh-ed25519", good.bytes()); !errors.Is(err, ErrNoSuchKey) {
		t.Fatalf("a key that does not exist: %v", err)
	}
	if _, err := l.Sign("k1", "box-a", "rsa-sha2-512", good.bytes()); err == nil {
		t.Fatal("signed with an algorithm that is not the key's")
	}

	blobB := honest(t, b).blob
	for name, change := range map[string]func(*request){
		"a session value of 31 bytes":  func(r *request) { r.session = r.session[:31] },
		"a session value of 33 bytes":  func(r *request) { r.session = append(r.session, 1) },
		"a session value of 20 bytes":  func(r *request) { r.session = r.session[:20] },
		"no session value":             func(r *request) { r.session = nil },
		"another message kind":         func(r *request) { r.kind = 51 },
		"another user":                 func(r *request) { r.user = "root" },
		"the user with a byte more":    func(r *request) { r.user += "x" },
		"an empty user":                func(r *request) { r.user = "" },
		"another service":              func(r *request) { r.service = "ssh-userauth" },
		"another method":               func(r *request) { r.method = "hostbased" },
		"the question, not the answer": func(r *request) { r.hasSig = 0 },
		"another algorithm":            func(r *request) { r.alg = "ssh-rsa" },
		"another key's public half":    func(r *request) { r.blob = blobB },
		"no public half":               func(r *request) { r.blob = nil },
		"a byte too many":              func(r *request) { r.extra = []byte{0} },
		"more fields after":            func(r *request) { r.extra = str([]byte("and sign this too")) },
	} {
		r := honest(t, a)
		change(&r)
		if out, err := l.Sign("k1", "box-a", "ssh-ed25519", r.bytes()); !errors.Is(err, ErrBadRequest) || out != nil {
			t.Errorf("%s: signed, or refused for another reason: %v", name, err)
		}
	}
	whole := good.bytes()
	for n := 0; n < len(whole); n++ {
		if out, err := l.Sign("k1", "box-a", "ssh-ed25519", whole[:n]); err == nil || out != nil {
			t.Fatalf("signed a request cut to %d bytes", n)
		}
	}
	// Anything that is not a sign-in request at all: a message, a file, another protocol's challenge.
	for _, other := range [][]byte{nil, []byte("please sign this"), bytes.Repeat([]byte{0}, 200), str(bytes.Repeat([]byte{7}, 32))} {
		if out, err := l.Sign("k1", "box-a", "ssh-ed25519", other); err == nil || out != nil {
			t.Fatalf("signed %q", other)
		}
	}
}

// The real thing: a real SSH sign-in through the engine's link, signed by the list. What the SSH library asks
// to have signed is exactly what Sign accepts.
func TestARealSignInIsSignedByTheList(t *testing.T) {
	l := New()
	info, _ := l.NewKey("k1", "box-a", "demo", t0)
	pub, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(info.PublicKey))
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	host, _ := ssh.NewSignerFromKey(hostPriv)
	box, err := hostile.Start(hostile.Config{HostSigner: host, Accept: pub})
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	dial := func(user, forBox string) error {
		lk, err := link.Dial(context.Background(), link.Target{Addr: box.Addr(), User: user, HostKey: host.PublicKey()},
			listSigner{l: l, name: "k1", box: forBox, pub: pub}, link.Options{})
		if err == nil {
			lk.Close()
		}
		return err
	}
	if err := dial("demo", "box-a"); err != nil {
		t.Fatal(err)
	}
	var e *link.Error
	if err := dial("root", "box-a"); !errors.As(err, &e) || e.Cause != link.NoSignature || !strings.Contains(err.Error(), "another user") {
		t.Fatalf("a sign-in as another user than the key's: %v", err)
	}
	if err := dial("demo", "box-b"); !errors.As(err, &e) || e.Cause != link.NoSignature {
		t.Fatalf("a sign-in for another box than the key's: %v", err)
	}
}

type listSigner struct {
	l         *List
	name, box string
	pub       ssh.PublicKey
}

func (s listSigner) PublicKey() ssh.PublicKey { return s.pub }
func (s listSigner) Sign(_ io.Reader, data []byte) (*ssh.Signature, error) {
	raw, err := s.l.Sign(s.name, s.box, "ssh-ed25519", data)
	if err != nil {
		return nil, err
	}
	sig := new(ssh.Signature)
	return sig, ssh.Unmarshal(raw, sig)
}

func TestKeysAreMadeApartAndNamedCarefully(t *testing.T) {
	l := New()
	a, _ := l.NewKey("k1", "box-a", "demo", t0)
	b, _ := l.NewKey("k2", "box-a", "demo", t0)
	if a.PublicKey == b.PublicKey || !strings.HasPrefix(a.PublicKey, "ssh-ed25519 ") {
		t.Fatalf("two keys: %q %q", a.PublicKey, b.PublicKey)
	}
	if _, err := l.NewKey("k1", "box-c", "demo", t0); !errors.Is(err, ErrKeyInUse) {
		t.Fatal(err)
	}
	for _, bad := range [][3]string{{"", "box", "u"}, {"k 3", "box", "u"}, {"../k", "box", "u"}, {"k3", "", "u"}, {"k3", "box", ""}, {"k3", "box", "a b"}, {"k3", "box", "a\nb"}, {strings.Repeat("k", 65), "box", "u"}} {
		if _, err := l.NewKey(bad[0], bad[1], bad[2], t0); !errors.Is(err, ErrBadName) {
			t.Errorf("%q: %v", bad, err)
		}
	}
	if err := l.Rebind("k1", "box-b", "root"); !errors.Is(err, ErrNotThisBox) {
		t.Fatal(err)
	}
	if err := l.Rebind("k1", "box-a", "deploy"); err != nil {
		t.Fatal(err)
	}
	r := honest(t, a)
	if _, err := l.Sign("k1", "box-a", "ssh-ed25519", r.bytes()); !errors.Is(err, ErrBadRequest) {
		t.Fatal("after the user changed, the key still signed for the old user")
	}
	r.user = "deploy"
	if _, err := l.Sign("k1", "box-a", "ssh-ed25519", r.bytes()); err != nil {
		t.Fatal(err)
	}
	if err := l.Delete("k1"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Sign("k1", "box-a", "ssh-ed25519", r.bytes()); !errors.Is(err, ErrNoSuchKey) {
		t.Fatal("a deleted key signed")
	}
}

// No private key is in anything this package hands out, except the sealed contents.
func TestNothingHandedOutHoldsAKey(t *testing.T) {
	l := New()
	info, _ := l.NewKey("k1", "box-a", "demo", t0)
	seed := l.keys["k1"].Seed
	seen := info.PublicKey + string(l.Public())
	for _, i := range l.Keys() {
		seen += i.PublicKey + i.Name + i.Box + i.User
	}
	if bytes.Contains([]byte(seen), seed) || strings.Contains(seen, string(mustJSON(seed))) {
		t.Fatal("a private key is in what the list hands out")
	}
	kept := append([]byte(nil), seed...)
	l.Wipe()
	if bytes.Equal(seed, kept) || len(l.keys) != 0 {
		t.Fatal("the key is still in memory after Wipe")
	}
}

func mustJSON(b []byte) []byte {
	out, _ := (&List{keys: map[string]*key{"x": {Seed: b}}}).Contents()
	return out[bytes.Index(out, []byte(`"seed":"`))+8 : bytes.Index(out, []byte(`","box"`))]
}

func TestTheListOnDisk(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "list.berth")
	backups := filepath.Join(dir, "backups")
	if err := os.Mkdir(backups, 0o700); err != nil {
		t.Fatal(err)
	}

	if _, err := Unlock(path, pw); !errors.Is(err, ErrNoList) {
		t.Fatal(err)
	}
	u, err := Create(path, pw, cheap, t0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Create(path, pw, cheap, t0); !errors.Is(err, ErrListExists) {
		t.Fatalf("a second Create replaced the list: %v", err)
	}
	info, _ := u.NewKey("k1", "box-a", "demo", t0)
	_ = u.SetPublic([]byte(`{"boxes":[{"id":"box-a","name":"demo-eu"}]}`))
	u.SetBackupDir(backups)
	first, _ := os.ReadFile(path)
	if backupErr, err := u.Save(t0.Add(time.Minute)); err != nil || backupErr != nil {
		t.Fatal(err, backupErr)
	}

	// What is on disk: the new list, the copy it replaced, the backup equal to the list, no leftovers.
	now, _ := os.ReadFile(path)
	prev, _ := os.ReadFile(PreviousPath(path))
	backup, _ := os.ReadFile(filepath.Join(backups, BackupName))
	if bytes.Equal(now, first) || !bytes.Equal(prev, first) || !bytes.Equal(backup, now) || !HasPrevious(path) {
		t.Fatal("after a save the files are not: the new list, the one before it, and a backup equal to the list")
	}
	if _, err := os.Stat(path + newSuffix); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a half-written file was left behind")
	}
	if runtime.GOOS != "windows" {
		for _, f := range []string{path, PreviousPath(path), filepath.Join(backups, BackupName)} {
			if st, _ := os.Stat(f); st.Mode().Perm() != 0o600 {
				t.Fatalf("%s is readable by others: %v", f, st.Mode())
			}
		}
	}
	// Nothing readable is in the file: not a box name, not a key.
	if bytes.Contains(now, []byte("demo")) || bytes.Contains(now, []byte("box-a")) || bytes.Contains(now, []byte("ed25519")) {
		t.Fatal("the saved file holds readable text of the list")
	}
	u.Close()

	// It opens again with the password, with everything in it, and says when it was saved.
	if _, err := Unlock(path, []byte("another password")); !errors.Is(err, vault.ErrPassword) {
		t.Fatal(err)
	}
	u, err = Unlock(path, pw)
	if err != nil {
		t.Fatal(err)
	}
	if got := u.Keys(); len(got) != 1 || got[0] != info || string(u.Public()) != `{"boxes":[{"id":"box-a","name":"demo-eu"}]}` || u.BackupDir() != backups || !u.SavedAt.Equal(t0.Add(time.Minute)) {
		t.Fatalf("reopened: %+v %s %s %v", u.Keys(), u.Public(), u.BackupDir(), u.SavedAt)
	}

	// The backup opens by itself, and becomes the list somewhere else: a restore.
	restored, err := Unlock(filepath.Join(backups, BackupName), pw)
	if err != nil {
		t.Fatal(err)
	}
	elsewhere := filepath.Join(t.TempDir(), "list.berth")
	restored.SetBackupDir("")
	if _, err := restored.SaveAs(elsewhere, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if again, err := Unlock(elsewhere, pw); err != nil || len(again.Keys()) != 1 {
		t.Fatalf("the restored list: %v", err)
	}

	// A backup that cannot be written is said, and the list is saved all the same.
	u.SetBackupDir(filepath.Join(dir, "no-such-folder"))
	backupErr, err := u.Save(t0.Add(2 * time.Minute))
	if err != nil || backupErr == nil {
		t.Fatalf("a missing backup folder: saved=%v backup=%v", err, backupErr)
	}
	if again, err := Unlock(path, pw); err != nil || !again.SavedAt.Equal(t0.Add(2*time.Minute)) {
		t.Fatalf("the list after a failed backup: %v", err)
	}

	// A damaged list is refused, is not replaced by anything, and the copy before it still opens.
	good, _ := os.ReadFile(path)
	bad := bytes.Clone(good)
	bad[len(bad)-1] ^= 1
	_ = os.WriteFile(path, bad, 0o600)
	if _, err := Unlock(path, pw); !errors.Is(err, vault.ErrDamaged) {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(after, bad) {
		t.Fatal("a damaged list was replaced")
	}
	if before, err := Unlock(PreviousPath(path), pw); err != nil || !before.SavedAt.Equal(t0.Add(time.Minute)) {
		t.Fatalf("the copy before: %v", err)
	}

	// A new password: the old one no longer opens it, the new one does, keys and all.
	_ = os.WriteFile(path, good, 0o600)
	u, _ = Unlock(path, pw)
	u.SetBackupDir("")
	if _, err := u.ChangePassword([]byte("a new and longer password"), cheap, t0.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := Unlock(path, pw); !errors.Is(err, vault.ErrPassword) {
		t.Fatal("the old password still opens the list")
	}
	if again, err := Unlock(path, []byte("a new and longer password")); err != nil || len(again.Keys()) != 1 {
		t.Fatal(err)
	}
}

// A save that cannot finish leaves the list exactly as it was.
func TestASaveThatFailsChangesNothing(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("needs a folder this user cannot write to")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "list.berth")
	u, err := Create(path, pw, cheap, t0)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	_, _ = u.NewKey("k1", "box-a", "demo", t0)
	_ = os.Chmod(dir, 0o500)
	defer os.Chmod(dir, 0o700)
	if _, err := u.Save(t0.Add(time.Minute)); err == nil {
		t.Fatal("a save into a folder that cannot be written reported success")
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(after, before) {
		t.Fatal("a failed save changed the list")
	}
}

func TestListsThatAreNotOursAreRefused(t *testing.T) {
	for _, c := range []string{
		``, `[]`, `{"v":2,"public":{},"keys":{}}`, `{"v":1,"public":{},"keys":{},"extra":1}`,
		`{"v":1,"public":{},"keys":{"k1":null}}`,
		`{"v":1,"public":{},"keys":{"k1":{"type":"ssh-ed25519","seed":"AAAA","box":"b","user":"u"}}}`,
		`{"v":1,"public":{},"keys":{"k1":{"type":"ssh-rsa","seed":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","box":"b","user":"u"}}}`,
		`{"v":1,"public":{},"keys":{"k 1":{"type":"ssh-ed25519","seed":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","box":"b","user":"u"}}}`,
	} {
		if _, err := Parse([]byte(c)); !errors.Is(err, ErrBadList) {
			t.Errorf("%s: %v", c, err)
		}
	}
	l := New()
	if err := l.SetPublic([]byte(`[1,2]`)); !errors.Is(err, ErrBadList) {
		t.Fatal(err)
	}
}

// The app's own part of the list must fit in one answer: the whole of it is sent back when the list opens,
// and a message between these programs carries 1 MiB at most. A list that could be saved and never opened
// again is refused at the moment it is set, not at the next start.
func TestThePublicPartMustFitInOneAnswer(t *testing.T) {
	l := New()
	fits := append(append([]byte(`{"filler":"`), bytes.Repeat([]byte("x"), MaxPublic-13)...), []byte(`"}`)...)
	if len(fits) != MaxPublic {
		t.Fatalf("the test's own value is %d bytes, not %d", len(fits), MaxPublic)
	}
	if err := l.SetPublic(fits); err != nil {
		t.Fatalf("the largest that fits was refused: %v", err)
	}
	tooMuch := append(append([]byte(`{"filler":"`), bytes.Repeat([]byte("x"), MaxPublic-12)...), []byte(`"}`)...)
	if err := l.SetPublic(tooMuch); !errors.Is(err, ErrTooBig) {
		t.Fatalf("one byte more was taken: %v", err)
	}
	if string(l.Public()) != string(fits) {
		t.Fatal("a refused set changed what was there")
	}
	// It must stay under what the protocol carries, with room for the rest of the answer.
	if MaxPublic >= 1024*1024 {
		t.Fatalf("MaxPublic is %d: that is not under one message", MaxPublic)
	}
}

// Whatever bytes it is asked to sign, Sign never panics, and signs only the one exact request.
func FuzzSign(f *testing.F) {
	seed := bytes.Repeat([]byte{9}, ed25519.SeedSize)
	l := &List{keys: map[string]*key{"k1": {Type: "ssh-ed25519", Seed: seed, Box: "box-a", User: "demo"}}}
	info := l.Keys()[0]
	good := honest(f, info).bytes()
	f.Add(good)
	f.Add(good[:40])
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, data []byte) {
		out, err := l.Sign("k1", "box-a", "ssh-ed25519", data)
		if err == nil || out != nil {
			// Signed: then it must be a request that differs from the good one only in its session value.
			if len(data) != len(good) || !bytes.Equal(data[36:], good[36:]) || !bytes.Equal(data[:4], good[:4]) {
				t.Fatalf("signed something that is not this key's sign-in: %x", data)
			}
		}
	})
}

// A list holding a key brought in from a file must open again. It did not: the reader took only the shape of
// a key this app makes, so one imported key made the list, its copy and its backup all unreadable at the next
// start, and he would have been locked out of every box with nothing to go back to. The round trip is held
// here for every kind of key file this app takes.
func TestAListHoldingAnImportedKeyOpensAgain(t *testing.T) {
	ed, _ := keyFile(t, "ed25519", "")
	rsaFile, _ := keyFile(t, "rsa2048", "")
	for _, c := range []struct {
		what string
		file []byte
	}{
		{"ed25519", ed},
		{"rsa", rsaFile},
	} {
		t.Run(c.what, func(t *testing.T) {
			l := &List{keys: map[string]*key{}, public: json.RawMessage(`{}`)}
			if _, err := l.TakeKey("b1", "b1", "demo", c.file, nil, time.Now()); err != nil {
				t.Fatalf("the key file was not taken: %v", err)
			}
			// Twice over, because adding a box saves twice: the copy beside the list is written from the
			// first save, so a list that could not be read would have taken its own way back with it.
			for again := 0; again < 2; again++ {
				body, err := l.Contents()
				if err != nil {
					t.Fatal(err)
				}
				back, err := Parse(body)
				if err != nil {
					t.Fatalf("a saved list holding an imported key could not be opened: %v", err)
				}
				if len(back.keys) != 1 {
					t.Fatalf("%d keys came back", len(back.keys))
				}
				// And it can still sign, which is the whole reason it is kept.
				s, wipe, err := back.keys["b1"].signer()
				if err != nil {
					t.Fatalf("the key that came back cannot sign: %v", err)
				}
				wipe()
				if s.PublicKey().Type() != back.keys["b1"].Type {
					t.Fatalf("it came back as a %s where it is a %s", s.PublicKey().Type(), back.keys["b1"].Type)
				}
				l = back
			}
		})
	}
}

// And a list that really is damaged is still refused: the way back from one of those is the whole reason the
// check is there at all.
func TestAListThatIsReallyDamagedIsStillRefused(t *testing.T) {
	for _, c := range []struct {
		what string
		k    *key
	}{
		{"neither a seed nor a private key", &key{Type: ssh.KeyAlgoED25519, Box: "b1", User: "demo"}},
		{"both at once", &key{Type: ssh.KeyAlgoED25519, Seed: make([]byte, ed25519.SeedSize), Priv: []byte{1, 2, 3}, Box: "b1", User: "demo"}},
		{"a seed of the wrong size", &key{Type: ssh.KeyAlgoED25519, Seed: make([]byte, 8), Box: "b1", User: "demo"}},
		{"a kind this app will not sign with", &key{Type: "ssh-dss", Priv: []byte{1, 2, 3}, Box: "b1", User: "demo"}},
		{"no box", &key{Type: ssh.KeyAlgoED25519, Seed: make([]byte, ed25519.SeedSize), User: "demo"}},
	} {
		l := &List{keys: map[string]*key{"b1": c.k}, public: json.RawMessage(`{}`)}
		body, err := l.Contents()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Parse(body); !errors.Is(err, ErrBadList) {
			t.Fatalf("%s: it was taken; it must be refused (%v)", c.what, err)
		}
	}
}
