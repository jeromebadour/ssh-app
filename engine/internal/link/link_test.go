package link

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/lab/faultproxy"
	"sshapp/engine/internal/lab/hostile"
	"sshapp/engine/internal/patience"
)

func edKey(t testing.TB) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func rsaKey(t testing.TB) ssh.Signer {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// countingSigner counts how often our key was asked to sign: a sign-in must never be tried at the wrong box.
type countingSigner struct {
	ssh.Signer
	n atomic.Int64
}

func (c *countingSigner) Sign(r io.Reader, data []byte) (*ssh.Signature, error) {
	c.n.Add(1)
	return c.Signer.Sign(r, data)
}

type world struct {
	box    *hostile.Box
	target Target
	user   *countingSigner
}

// setup starts a box with the given changes to an honest config, and a target that pins its true identity.
func setup(t *testing.T, change func(*hostile.Config)) *world {
	t.Helper()
	host, user := edKey(t), &countingSigner{Signer: edKey(t)}
	cfg := hostile.Config{HostSigner: host, Accept: user.PublicKey()}
	if change != nil {
		change(&cfg)
	}
	box, err := hostile.Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(box.Close)
	return &world{box: box, user: user, target: Target{Addr: box.Addr(), User: "demo", HostKey: host.PublicKey()}}
}

var quick = Options{Deadlines: Deadlines{Connect: 2 * time.Second, KeyExchange: 400 * time.Millisecond, SignIn: 400 * time.Millisecond}}

func mustFail(t *testing.T, w *world, opt Options, cause Cause, phase Phase) *Error {
	t.Helper()
	l, err := Dial(context.Background(), w.target, w.user, opt)
	if err == nil {
		l.Close()
		t.Fatalf("connected; wanted %s while %s", cause, phase)
	}
	var e *Error
	if !errors.As(err, &e) || e.Cause != cause || e.Phase != phase {
		t.Fatalf("got %v; wanted %s while %s", err, cause, phase)
	}
	return e
}

func TestConnectsAndSaysWhatWasAgreed(t *testing.T) {
	var phases []Phase
	var mu sync.Mutex
	var banner string
	w := setup(t, func(c *hostile.Config) { c.Banner = "Welcome to demo-eu\n" })
	l, err := Dial(context.Background(), w.target, w.user, Options{
		OnPhase:  func(p Phase) { mu.Lock(); phases = append(phases, p); mu.Unlock() },
		OnBanner: func(m string) { banner = m },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	d := l.Details()
	if d.KeyExchange != ssh.KeyExchangeMLKEM768X25519 || !d.PostQuantum || d.Cipher != ssh.CipherAES256GCM || d.IdentityAlgorithm != ssh.KeyAlgoED25519 {
		t.Fatalf("agreed: %+v", d)
	}
	mu.Lock()
	got := append([]Phase(nil), phases...)
	mu.Unlock()
	want := []Phase{Connecting, KeyExchange, SigningIn, Up}
	if len(got) != len(want) {
		t.Fatalf("phases: %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("phases: %v", got)
		}
	}
	if banner != "Welcome to demo-eu\n" {
		t.Fatalf("banner: %q", banner)
	}
	if w.user.n.Load() != 1 {
		t.Fatalf("our key signed %d times", w.user.n.Load())
	}
}

func TestOlderBoxFallsBackToCurve25519(t *testing.T) {
	w := setup(t, func(c *hostile.Config) { c.KeyExchanges = []string{ssh.KeyExchangeCurve25519} })
	l, err := Dial(context.Background(), w.target, w.user, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if d := l.Details(); d.KeyExchange != ssh.KeyExchangeCurve25519 || d.PostQuantum {
		t.Fatalf("agreed: %+v", d)
	}
}

// A box that has only choices we do not accept is refused with the exact reason, and our key is never used.
func TestWeakOffersAreRefused(t *testing.T) {
	for _, c := range []struct {
		name   string
		change func(*hostile.Config)
		what   string
	}{
		{"only ChaCha20", func(c *hostile.Config) { c.Ciphers = []string{ssh.CipherChaCha20Poly1305} }, "cipher"},
		{"only AES-CTR", func(c *hostile.Config) { c.Ciphers = []string{ssh.CipherAES256CTR, ssh.CipherAES128CTR} }, "cipher"},
		{"only old Diffie-Hellman", func(c *hostile.Config) {
			c.KeyExchanges = []string{ssh.KeyExchangeDH14SHA256, ssh.KeyExchangeECDHP256}
		}, "key exchange"},
	} {
		t.Run(c.name, func(t *testing.T) {
			w := setup(t, c.change)
			e := mustFail(t, w, Options{}, WeakOffer, KeyExchange)
			if e.What != c.what || len(e.Ours) == 0 || len(e.Box) == 0 {
				t.Fatalf("%+v", e)
			}
			if w.user.n.Load() != 0 {
				t.Fatal("our key was used at a box we refused")
			}
		})
	}
}

// An RSA box that can only sign its identity with SHA-1 is refused: we pin its RSA key but offer SHA-2 only.
func TestRSAIdentityNeedsSHA2(t *testing.T) {
	host := rsaKey(t)
	sha1Only, err := ssh.NewSignerWithAlgorithms(host.(ssh.AlgorithmSigner), []string{ssh.KeyAlgoRSA})
	if err != nil {
		t.Fatal(err)
	}
	w := setup(t, func(c *hostile.Config) { c.HostSigner = sha1Only })
	w.target.HostKey = host.PublicKey()
	if e := mustFail(t, w, Options{}, WeakOffer, KeyExchange); e.What != "identity algorithm" {
		t.Fatalf("%+v", e)
	}

	w = setup(t, func(c *hostile.Config) { c.HostSigner = host })
	w.target.HostKey = host.PublicKey()
	l, err := Dial(context.Background(), w.target, w.user, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if a := l.Details().IdentityAlgorithm; a != ssh.KeyAlgoRSASHA512 {
		t.Fatalf("an RSA box signed its identity with %s", a)
	}
}

// A box that shows another key than the pinned one is a hard stop: we learn which key it showed, and our own
// key is never asked to sign anything for it.
func TestAChangedIdentityIsAHardStop(t *testing.T) {
	impostor := edKey(t)
	w := setup(t, func(c *hostile.Config) { c.HostSigner = impostor })
	w.target.HostKey = edKey(t).PublicKey() // what we pinned is not what answers
	e := mustFail(t, w, Options{}, IdentityChanged, KeyExchange)
	if e.Got == nil || string(e.Got.Marshal()) != string(impostor.PublicKey().Marshal()) {
		t.Fatal("the key the box showed was not reported")
	}
	if w.user.n.Load() != 0 {
		t.Fatal("our key was used at a box that is not the pinned one")
	}

	// The same when the box answers with a key of another kind than the pinned one.
	w = setup(t, func(c *hostile.Config) { c.HostSigner = rsaKey(t) })
	mustFail(t, w, Options{}, WeakOffer, KeyExchange) // it has no ed25519 identity at all: nothing to compare
	if w.user.n.Load() != 0 {
		t.Fatal("our key was used at a box that is not the pinned one")
	}
}

func TestAKeyTheBoxDoesNotKnow(t *testing.T) {
	w := setup(t, func(c *hostile.Config) { c.Accept = edKey(t).PublicKey() })
	mustFail(t, w, Options{}, SignInFailed, SigningIn)
}

// Each phase has its own deadline, and what ends it is ours: the raw connection closed by a timer.
func TestEachPhaseHasItsDeadline(t *testing.T) {
	t.Run("a box that takes the connection and says nothing", func(t *testing.T) {
		w := setup(t, func(c *hostile.Config) { c.Silent = true })
		began := time.Now()
		mustFail(t, w, quick, TimedOut, KeyExchange)
		if d := time.Since(began); d < 350*time.Millisecond || d > 3*time.Second {
			t.Fatalf("the 400 ms deadline took %v", d)
		}
	})
	t.Run("a box that never answers the sign-in", func(t *testing.T) {
		w := setup(t, func(c *hostile.Config) { c.StallSignIn = true })
		mustFail(t, w, quick, TimedOut, SigningIn)
	})
	t.Run("a link that goes silent in the middle of the handshake", func(t *testing.T) {
		w := setup(t, nil)
		p, err := faultproxy.Listen(w.box.Addr())
		if err != nil {
			t.Fatal(err)
		}
		defer p.Close()
		p.Set(faultproxy.Faults{Hold: true})
		w.target.Addr = p.Addr()
		mustFail(t, w, quick, TimedOut, KeyExchange)
	})
	t.Run("a slow link is not a dead one", func(t *testing.T) {
		w := setup(t, nil)
		p, err := faultproxy.Listen(w.box.Addr())
		if err != nil {
			t.Fatal(err)
		}
		defer p.Close()
		p.Set(faultproxy.Faults{Delay: 60 * time.Millisecond, Jitter: 20 * time.Millisecond})
		w.target.Addr = p.Addr()
		l, err := Dial(context.Background(), w.target, w.user, Options{})
		if err != nil {
			t.Fatal(err)
		}
		l.Close()
	})
}

func TestNothingListening(t *testing.T) {
	ln, _ := net.Listen("tcp4", "127.0.0.1:0")
	addr := ln.Addr().String()
	_ = ln.Close()
	w := setup(t, nil)
	w.target.Addr = addr
	mustFail(t, w, quick, Refused, Connecting)
}

func TestANameThatDoesNotResolve(t *testing.T) {
	w := setup(t, nil)
	w.target.Addr = "no-such-box.invalid:22"
	mustFail(t, w, quick, Unreachable, Connecting)
}

func TestCancelEndsAnAttemptAtOnce(t *testing.T) {
	w := setup(t, func(c *hostile.Config) { c.Silent = true })
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	began := time.Now()
	_, err := Dial(ctx, w.target, w.user, Options{})
	var e *Error
	if !errors.As(err, &e) || e.Cause != Cancelled {
		t.Fatalf("%v", err)
	}
	if d := time.Since(began); d > 2*time.Second {
		t.Fatalf("cancel took %v", d)
	}
}

// A box gets nothing from us: every kind of channel it tries to open is refused, and the link stays up.
func TestABoxCannotOpenChannelsOnUs(t *testing.T) {
	results := make(chan error, 8)
	kinds := []string{"forwarded-tcpip", "x11", "auth-agent@openssh.com", "session", "direct-tcpip", "anything-else"}
	w := setup(t, func(c *hostile.Config) {
		c.OnUp = func(conn *ssh.ServerConn) {
			for _, kind := range kinds {
				_, _, err := conn.OpenChannel(kind, nil)
				results <- err
			}
			ok, _, err := conn.SendRequest("tcpip-forward", true, nil)
			if err == nil && ok {
				results <- errors.New("a request was granted")
			} else {
				results <- nil
			}
		}
	})
	l, err := Dial(context.Background(), w.target, w.user, Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	for range kinds {
		err := <-results
		var open *ssh.OpenChannelError
		if !errors.As(err, &open) || open.Reason != ssh.Prohibited {
			t.Fatalf("a channel opened by the box ended with %v", err)
		}
	}
	if err := <-results; err != nil {
		t.Fatal(err)
	}
	if l.RefusedChannels() != int64(len(kinds)) {
		t.Fatalf("refused %d of %d", l.RefusedChannels(), len(kinds))
	}
	select {
	case <-l.Done():
		t.Fatal("the link ended")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestALongBannerIsCut(t *testing.T) {
	var got string
	w := setup(t, func(c *hostile.Config) { c.Banner = strings.Repeat("A", 20*1024) })
	l, err := Dial(context.Background(), w.target, w.user, Options{OnBanner: func(m string) { got = m }})
	if err != nil {
		t.Fatal(err)
	}
	l.Close()
	if len(got) != BannerMax {
		t.Fatalf("took %d bytes of banner", len(got))
	}
}

// How a link ends is said exactly, and nothing here ends it: a held link stays up.
func TestHowALinkEnds(t *testing.T) {
	open := func(t *testing.T) (*world, *faultproxy.Proxy, *Link) {
		w := setup(t, nil)
		p, err := faultproxy.Listen(w.box.Addr())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(p.Close)
		w.target.Addr = p.Addr()
		l, err := Dial(context.Background(), w.target, w.user, Options{})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(l.Close)
		return w, p, l
	}
	ended := func(t *testing.T, l *Link, want Cause) {
		t.Helper()
		select {
		case <-l.Done():
			if l.End().Cause != want {
				t.Fatalf("ended with %v; wanted %s", l.End(), want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("did not end; wanted %s", want)
		}
	}
	t.Run("a reset", func(t *testing.T) {
		_, p, l := open(t)
		p.Reset()
		ended(t, l, Reset)
	})
	t.Run("the box closes it", func(t *testing.T) {
		w, _, l := open(t)
		w.box.Close()
		ended(t, l, ClosedByBox)
	})
	t.Run("we close it", func(t *testing.T) {
		_, _, l := open(t)
		l.Close()
		ended(t, l, Cancelled)
	})
	t.Run("a held link is kept", func(t *testing.T) {
		_, p, l := open(t)
		p.Set(faultproxy.Faults{Hold: true})
		select {
		case <-l.Done():
			t.Fatalf("a silent link was ended: %v", l.End())
		case <-time.After(1500 * time.Millisecond):
		}
		p.Set(faultproxy.Faults{})
		if ok, _, err := l.Conn().SendRequest("keepalive@openssh.com", true, nil); err != nil {
			t.Fatalf("after the link came back it no longer answers: %v (%v)", err, ok)
		}
	})
}

// The operating system's ten-minute patience is on the very connection the link runs over.
func TestPatienceIsSetOnTheConnection(t *testing.T) {
	seen := make(chan time.Duration, 1)
	testHookConnected = func(c *net.TCPConn) {
		d, err := patience.Get(c)
		if err != nil {
			t.Error(err)
		}
		seen <- d
	}
	defer func() { testHookConnected = nil }()
	w := setup(t, nil)
	l, err := Dial(context.Background(), w.target, w.user, Options{})
	if err != nil {
		t.Fatal(err)
	}
	l.Close()
	if d := <-seen; d != patience.Default {
		t.Fatalf("the connection's patience is %v", d)
	}
}

func TestBadTargetsAreRefusedBeforeAnyConnection(t *testing.T) {
	w := setup(t, nil)
	for _, change := range []func(*Target){
		func(x *Target) { x.HostKey = nil },
		func(x *Target) { x.User = "" },
		func(x *Target) { x.Addr = "" },
	} {
		tg := w.target
		change(&tg)
		if _, err := Dial(context.Background(), tg, w.user, Options{}); err == nil {
			t.Fatal("connected to an incomplete target")
		}
	}
	if _, err := Dial(context.Background(), w.target, nil, Options{}); err == nil {
		t.Fatal("connected with no signer")
	}
}

// What the client offers, read off the wire: its first packet is sent in the clear and lists everything it is
// willing to use. Nothing may be in it but what the plan allows (B2.2), whatever the library's defaults are.
func TestWhatIsOfferedOnTheWire(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	lists := make(chan [][]string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		_, _ = c.Write([]byte("SSH-2.0-Recorder\r\n"))
		one := make([]byte, 1)
		for { // the client's version line
			if _, err := io.ReadFull(c, one); err != nil || one[0] == '\n' {
				break
			}
		}
		head := make([]byte, 5)
		if _, err := io.ReadFull(c, head); err != nil {
			return
		}
		n := int(head[0])<<24 | int(head[1])<<16 | int(head[2])<<8 | int(head[3])
		body := make([]byte, n-1)
		if _, err := io.ReadFull(c, body); err != nil || body[0] != 20 { // 20 is SSH_MSG_KEXINIT
			return
		}
		at := 17 // the message number and a 16-byte cookie
		var out [][]string
		for i := 0; i < 10; i++ {
			l := int(body[at])<<24 | int(body[at+1])<<16 | int(body[at+2])<<8 | int(body[at+3])
			at += 4
			var names []string
			if l > 0 {
				names = strings.Split(string(body[at:at+l]), ",")
			}
			out = append(out, names)
			at += l
		}
		lists <- out
	}()

	w := setup(t, nil)
	w.target.Addr = ln.Addr().String()
	_, _ = Dial(context.Background(), w.target, w.user, quick)
	var got [][]string
	select {
	case got = <-lists:
	case <-time.After(5 * time.Second):
		t.Fatal("the client's offer never arrived")
	}
	want := [][]string{
		// The last three are not key exchanges: the same curve25519 under its older name, and two markers
		// (extension support, and the strict mode that closes the handshake attack of 2023).
		{"mlkem768x25519-sha256", "curve25519-sha256", "curve25519-sha256@libssh.org", "ext-info-c", "kex-strict-c-v00@openssh.com"},
		{"ssh-ed25519"},
		{"aes256-gcm@openssh.com", "aes128-gcm@openssh.com"},
		{"aes256-gcm@openssh.com", "aes128-gcm@openssh.com"},
		{"hmac-sha2-256-etm@openssh.com"},
		{"hmac-sha2-256-etm@openssh.com"},
		{"none"},
		{"none"},
		nil,
		nil,
	}
	names := []string{"key exchange", "identity algorithm", "cipher to the box", "cipher from the box", "MAC to the box", "MAC from the box", "compression to the box", "compression from the box", "languages to the box", "languages from the box"}
	for i := range want {
		if strings.Join(got[i], ",") != strings.Join(want[i], ",") {
			t.Errorf("%s: offered %q, the plan allows %q", names[i], got[i], want[i])
		}
	}
}
