package link

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"errors"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/lab/faultproxy"
	"sshapp/engine/internal/lab/hostile"
)

func ecdsaKey(t testing.TB) ssh.Signer {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func same(a, b ssh.PublicKey) bool {
	return a != nil && b != nil && string(a.Marshal()) == string(b.Marshal())
}

func identifyFails(t *testing.T, addr string, opt Options, cause Cause, phase Phase) *Error {
	t.Helper()
	key, e := Identify(context.Background(), addr, opt)
	if e == nil || key != nil {
		t.Fatalf("an identity came back; wanted %s while %s", cause, phase)
	}
	if e.Cause != cause || e.Phase != phase {
		t.Fatalf("got %v; wanted %s while %s", e, cause, phase)
	}
	return e
}

// Asking a box who it is gives the key it proved it holds, and asks nothing else of it: nobody tried to sign
// in, in any way, and no user name reached the box.
func TestIdentifyTakesTheIdentityAndNothingElse(t *testing.T) {
	w := setup(t, func(c *hostile.Config) { c.Sessions = true })
	var phases []Phase
	key, e := Identify(context.Background(), w.box.Addr(), Options{OnPhase: func(p Phase) { phases = append(phases, p) }})
	if e != nil {
		t.Fatal(e)
	}
	if !same(key, w.target.HostKey) {
		t.Fatal("the key returned is not the box's identity")
	}
	if len(phases) != 2 || phases[0] != Connecting || phases[1] != KeyExchange {
		t.Fatalf("phases said: %v; a first-connection check never signs in and is never up", phases)
	}
	time.Sleep(150 * time.Millisecond) // anything we wrongly sent would have arrived by now
	if n, users := w.box.SignInTries(); n != 0 || len(users) != 0 {
		t.Fatalf("the box saw %d sign-in tries (users %q); it must see none", n, users)
	}
	if w.user.n.Load() != 0 || len(w.box.Sessions()) != 0 {
		t.Fatal("a key was used, or a session was opened")
	}
}

// A box with both kinds of identity is known by its ed25519 one; RSA is taken only from a box that has no
// other, and then with SHA-2.
func TestIdentifyPrefersEd25519(t *testing.T) {
	ed, rsaHost := edKey(t), rsaKey(t)
	w := setup(t, func(c *hostile.Config) { c.HostSigner = rsaHost; c.MoreHosts = []ssh.Signer{ed} })
	key, e := Identify(context.Background(), w.box.Addr(), Options{})
	if e != nil || !same(key, ed.PublicKey()) {
		t.Fatalf("with both, wanted the ed25519 identity: %v %v", key, e)
	}
	w = setup(t, func(c *hostile.Config) { c.HostSigner = rsaHost })
	key, e = Identify(context.Background(), w.box.Addr(), Options{})
	if e != nil || !same(key, rsaHost.PublicKey()) {
		t.Fatalf("with RSA only, wanted the RSA identity: %v %v", key, e)
	}
}

// A box whose only identity is of a kind the app does not accept is refused with the exact reason; so is one
// with only weaker key exchanges or ciphers. There is no weaker second try.
func TestIdentifyRefusesWeakOffers(t *testing.T) {
	w := setup(t, func(c *hostile.Config) { c.HostSigner = ecdsaKey(t) })
	e := identifyFails(t, w.box.Addr(), Options{}, WeakOffer, KeyExchange)
	if e.What != "identity algorithm" || strings.Join(e.Ours, ",") != "ssh-ed25519,rsa-sha2-512,rsa-sha2-256" || strings.Join(e.Box, ",") != "ecdsa-sha2-nistp256" {
		t.Fatalf("said %q, ours %q, the box's %q", e.What, e.Ours, e.Box)
	}
	w = setup(t, func(c *hostile.Config) { c.KeyExchanges = []string{ssh.InsecureKeyExchangeDH14SHA1} })
	if e := identifyFails(t, w.box.Addr(), Options{}, WeakOffer, KeyExchange); e.What != "key exchange" {
		t.Fatalf("said %q", e.What)
	}
	w = setup(t, func(c *hostile.Config) { c.Ciphers = []string{ssh.CipherChaCha20Poly1305} })
	if e := identifyFails(t, w.box.Addr(), Options{}, WeakOffer, KeyExchange); e.What != "cipher" {
		t.Fatalf("said %q", e.What)
	}
}

// What is offered while asking is exactly what a link offers, but for the identity algorithms: there the three
// the plan allows for a box not yet known, in that order. Nothing with SHA-1, no DSA, no ECDSA.
func TestWhatIdentifyOffersOnTheWire(t *testing.T) {
	addr, lists := recordOffer(t)
	_, _ = Identify(context.Background(), addr, quick)
	var got [][]string
	select {
	case got = <-lists:
	case <-time.After(5 * time.Second):
		t.Fatal("the client's offer never arrived")
	}
	want := [][]string{
		{"mlkem768x25519-sha256", "curve25519-sha256", "curve25519-sha256@libssh.org", "ext-info-c", "kex-strict-c-v00@openssh.com"},
		{"ssh-ed25519", "rsa-sha2-512", "rsa-sha2-256"},
		{"aes256-gcm@openssh.com", "aes128-gcm@openssh.com"},
		{"aes256-gcm@openssh.com", "aes128-gcm@openssh.com"},
		{"hmac-sha2-256-etm@openssh.com"},
		{"hmac-sha2-256-etm@openssh.com"},
		{"none"},
		{"none"},
		nil,
		nil,
	}
	for i := range want {
		if strings.Join(got[i], ",") != strings.Join(want[i], ",") {
			t.Errorf("list %d: offered %q, the plan allows %q", i, got[i], want[i])
		}
	}
}

// Asking has its deadlines too, each a timer that closes the raw connection, and says exactly what went wrong.
func TestIdentifyNeverWaitsWithoutALimit(t *testing.T) {
	t.Run("a box that takes the connection and says nothing", func(t *testing.T) {
		w := setup(t, func(c *hostile.Config) { c.Silent = true })
		began := time.Now()
		identifyFails(t, w.box.Addr(), quick, TimedOut, KeyExchange)
		if d := time.Since(began); d < 350*time.Millisecond || d > 3*time.Second {
			t.Fatalf("the 400 ms deadline took %v", d)
		}
	})
	t.Run("a link that goes silent in the middle", func(t *testing.T) {
		w := setup(t, nil)
		p, err := faultproxy.Listen(w.box.Addr())
		if err != nil {
			t.Fatal(err)
		}
		defer p.Close()
		p.Set(faultproxy.Faults{Hold: true})
		identifyFails(t, p.Addr(), quick, TimedOut, KeyExchange)
	})
	t.Run("a slow link still answers", func(t *testing.T) {
		w := setup(t, nil)
		p, err := faultproxy.Listen(w.box.Addr())
		if err != nil {
			t.Fatal(err)
		}
		defer p.Close()
		p.Set(faultproxy.Faults{Delay: 60 * time.Millisecond, Jitter: 20 * time.Millisecond})
		key, e := Identify(context.Background(), p.Addr(), Options{})
		if e != nil || !same(key, w.target.HostKey) {
			t.Fatalf("%v %v", key, e)
		}
	})
	t.Run("nothing listening", func(t *testing.T) {
		w := setup(t, nil)
		addr := w.box.Addr()
		w.box.Close()
		identifyFails(t, addr, quick, Refused, Connecting)
	})
	t.Run("a name that does not resolve", func(t *testing.T) {
		identifyFails(t, "no-such-box.invalid:22", quick, Unreachable, Connecting)
	})
	t.Run("no box given", func(t *testing.T) {
		identifyFails(t, "", quick, Protocol, Connecting)
	})
	t.Run("told to stop", func(t *testing.T) {
		w := setup(t, func(c *hostile.Config) { c.Silent = true })
		ctx, cancel := context.WithCancel(context.Background())
		time.AfterFunc(100*time.Millisecond, cancel)
		began := time.Now()
		_, e := Identify(ctx, w.box.Addr(), Options{})
		if e == nil || e.Cause != Cancelled {
			t.Fatalf("%v", e)
		}
		if d := time.Since(began); d > 2*time.Second {
			t.Fatalf("cancel took %v", d)
		}
	})
}

// The error Identify gives is the package's own kind, usable wherever a link's is.
func TestIdentifyErrorsAreLinkErrors(t *testing.T) {
	_, e := Identify(context.Background(), "", Options{})
	var as *Error
	if !errors.As(error(e), &as) {
		t.Fatal("not a link error")
	}
}
