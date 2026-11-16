// Package link opens the engine's one SSH connection to its one box (plan B2.2, B2.3, B8).
//
// The SSH protocol and its cryptography are golang.org/x/crypto/ssh. Ours is what surrounds it:
//
//   - What is offered. Two key exchanges, two ciphers, one identity algorithm family, public-key sign-in with
//     one key. Nothing else, and no "connect anyway": a box that has only weaker choices is refused with the
//     exact reason.
//   - Who the box is. The box's identity is pinned beforehand; only that key's algorithm is offered and the
//     whole key is compared. A different key is a hard stop, before any sign-in is attempted.
//   - How long each phase may take. The library has no deadlines of its own, so each phase has a timer that
//     closes the raw connection under it. Once the link is up, nothing here ends it on a timer.
//   - What the box may ask of us. Nothing: every channel a box tries to open is refused, every request ignored.
//   - Why it failed. Every failure carries one cause from a fixed list, so the tab can say exactly what happened.
//
// Signing is asked for, never held: Dial takes a Signer, and the engine's signer forwards each request to the
// key process. No key is ever in this package.
package link

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/patience"
)

// What the client offers. The order is the order of preference.
var (
	keyExchanges = []string{ssh.KeyExchangeMLKEM768X25519, ssh.KeyExchangeCurve25519}
	ciphers      = []string{ssh.CipherAES256GCM, ssh.CipherAES128GCM}
	// Not used with the ciphers above (they authenticate by themselves); the list must still hold nothing weak.
	macs = []string{ssh.HMACSHA256ETM}
)

// Target is the one box this engine was aimed at.
type Target struct {
	Addr    string        // host:port
	User    string        // the account on the box
	HostKey ssh.PublicKey // the pinned identity; never empty
}

// Phase is where a connection attempt is.
type Phase string

const (
	Connecting  Phase = "connecting"   // opening the TCP connection
	KeyExchange Phase = "key-exchange" // agreeing keys and checking the box's identity
	SigningIn   Phase = "signing-in"
	Up          Phase = "up"
)

// Cause is why an attempt failed or a link ended. The list is fixed: the tab shows one of these, in words.
type Cause string

const (
	Refused         Cause = "refused"          // the box (or something before it) refused the connection
	Unreachable     Cause = "unreachable"      // no route, no network, or the name did not resolve
	TimedOut        Cause = "timed-out"        // the phase in Error.Phase took longer than its deadline
	WeakOffer       Cause = "weak-offer"       // the box offers nothing we accept for Error.What
	IdentityChanged Cause = "identity-changed" // the box showed a key that is not the pinned one
	SignInFailed    Cause = "sign-in-failed"   // the box did not accept our key for this user
	NoSignature     Cause = "no-signature"     // our own side gave no usable signature; the box was not asked
	Reset           Cause = "reset"            // the connection was reset
	ClosedByBox     Cause = "closed-by-box"    // the box closed the connection
	SilentTooLong   Cause = "silent-too-long"  // no answer for the operating system's whole patience (ten minutes)
	Cancelled       Cause = "cancelled"        // we were told to stop
	Protocol        Cause = "protocol"         // anything else the SSH layer reported; Error.Err has it
)

// Error is a failed attempt or an ended link.
type Error struct {
	Cause Cause
	Phase Phase
	What  string        // WeakOffer: "key exchange", "cipher" or "identity algorithm"
	Ours  []string      // WeakOffer: what we offered
	Box   []string      // WeakOffer: what the box offered. Text from the box: show it escaped, marked as the box's
	Got   ssh.PublicKey // IdentityChanged: the key the box showed
	Err   error
}

func (e *Error) Error() string {
	s := "link: " + string(e.Cause) + " while " + string(e.Phase)
	if e.What != "" {
		s += " (" + e.What + ")"
	}
	if e.Err != nil {
		s += ": " + e.Err.Error()
	}
	return s
}

func (e *Error) Unwrap() error { return e.Err }

// Deadlines are the longest each phase may take (plan B8).
type Deadlines struct {
	Connect, KeyExchange, SignIn time.Duration
}

// DefaultDeadlines are the plan's values.
var DefaultDeadlines = Deadlines{Connect: 10 * time.Second, KeyExchange: 15 * time.Second, SignIn: 20 * time.Second}

// Options are everything about an attempt that is not the box itself. The zero value is the plan's behaviour.
type Options struct {
	Deadlines Deadlines        // zero fields take DefaultDeadlines
	OnPhase   func(Phase)      // told each phase as it starts; must not block
	OnBanner  func(msg string) // the box's sign-in text, cut to BannerMax. Text from the box: terminal only
}

// BannerMax is the most sign-in text taken from a box over the whole of one link, however many messages
// it arrives in.
//
// A box may send sign-in text as many times as it likes: the protocol sets no limit and the library hands
// every message to the callback. So this is a budget for the whole link. A box that is already in someone
// else's hands would otherwise send sign-in text without end, and every byte of it would be carried to the
// window and kept there.
const BannerMax = 8 * 1024

// bannerBudget hands out what is left of that budget, message by message. A message that does not fit is cut
// to what is left; once nothing is left, every message is dropped. Used from one goroutine only.
type bannerBudget struct{ left int }

func (b *bannerBudget) take(msg string) string {
	if b.left <= 0 {
		return ""
	}
	if len(msg) > b.left {
		msg = msg[:b.left]
	}
	b.left -= len(msg)
	return msg
}

// Details are what was agreed, for the tab's details.
type Details struct {
	KeyExchange       string
	Cipher            string
	IdentityAlgorithm string
	PostQuantum       bool
}

// Link is an open, signed-in connection.
type Link struct {
	conn    ssh.Conn
	details Details
	refused atomic.Int64
	done    chan struct{}
	endErr  *Error
}

// Dial opens the link, or says exactly why not. It returns once the box has accepted the sign-in.
func Dial(ctx context.Context, t Target, signer ssh.Signer, opt Options) (*Link, error) {
	if t.HostKey == nil || t.User == "" || t.Addr == "" || signer == nil {
		return nil, &Error{Cause: Protocol, Phase: Connecting, Err: errors.New("no box, user, pinned identity or signer given")}
	}
	identityAlgos, err := algorithmsFor(t.HostKey)
	if err != nil {
		return nil, &Error{Cause: Protocol, Phase: Connecting, Err: err}
	}
	d := opt.Deadlines
	if d.Connect <= 0 {
		d.Connect = DefaultDeadlines.Connect
	}
	if d.KeyExchange <= 0 {
		d.KeyExchange = DefaultDeadlines.KeyExchange
	}
	if d.SignIn <= 0 {
		d.SignIn = DefaultDeadlines.SignIn
	}
	a := &attempt{phase: Connecting, onPhase: opt.OnPhase}
	a.tell(Connecting)

	tcp, oerr := openTCP(ctx, t.Addr, d.Connect)
	if oerr != nil {
		return nil, oerr
	}
	a.conn = tcp
	if testHookConnected != nil {
		testHookConnected(tcp)
	}

	// From here every phase has a timer that closes the raw connection. Cancelling does the same.
	a.enter(KeyExchange, d.KeyExchange)
	stopWatch := context.AfterFunc(ctx, func() { a.end(Cancelled) })
	defer stopWatch()

	// What is left of the sign-in text this link will take. The callback below is called from the library's
	// own sign-in goroutine, one message at a time, before this function returns, so it needs no lock.
	banner := &bannerBudget{left: BannerMax}

	cfg := &ssh.ClientConfig{
		Config: ssh.Config{KeyExchanges: keyExchanges, Ciphers: ciphers, MACs: macs},
		User:   t.User,
		Auth: []ssh.AuthMethod{ssh.PublicKeysCallback(func() ([]ssh.Signer, error) {
			a.enter(SigningIn, d.SignIn)
			return []ssh.Signer{a.watch(signer)}, nil
		})},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if !bytes.Equal(key.Marshal(), t.HostKey.Marshal()) {
				a.got = key
				return errIdentity
			}
			return nil
		},
		HostKeyAlgorithms: identityAlgos,
		// A box may send sign-in text as many times as it likes: the protocol sets no limit and the library
		// takes every message. So BannerMax is a budget for the whole link, not for one message, and once it
		// is spent nothing more is passed on. Without the budget a box that is already in someone else's
		// hands could send sign-in text without end and leave the window with it.
		BannerCallback: func(msg string) error {
			if opt.OnBanner == nil {
				return nil
			}
			if take := banner.take(msg); take != "" {
				opt.OnBanner(take)
			}
			return nil
		},
	}
	// The operating system reports a reset once, to whichever call asks first, and the library's writer and
	// reader both ask: so the wire remembers the first hard error itself, and that is the cause we report.
	w := &wire{TCPConn: tcp}
	a.wire = w
	conn, chans, reqs, err := ssh.NewClientConn(w, t.Addr, cfg)
	if err != nil {
		_ = tcp.Close()
		return nil, a.explain(err)
	}
	if !a.finish() { // a timer or a cancel got in at the last moment and closed the connection
		_ = conn.Close()
		return nil, a.explain(errors.New("ended as it came up"))
	}

	l := &Link{conn: conn, done: make(chan struct{})}
	if m, ok := conn.(ssh.AlgorithmsConnMetadata); ok {
		n := m.Algorithms()
		l.details = Details{KeyExchange: n.KeyExchange, Cipher: n.Write.Cipher, IdentityAlgorithm: n.HostKey, PostQuantum: n.KeyExchange == ssh.KeyExchangeMLKEM768X25519}
	}
	// A box gets nothing from us: no channel it opens is accepted, no request it makes is granted.
	go func() {
		for ch := range chans {
			l.refused.Add(1)
			_ = ch.Reject(ssh.Prohibited, "")
		}
	}()
	go ssh.DiscardRequests(reqs)
	go func() {
		werr := conn.Wait()
		l.endErr = classifyEnd(w.firstError(werr))
		close(l.done)
	}()
	return l, nil
}

// openTCP opens the raw connection within its deadline, with the operating system's patience set on it, or
// says exactly why not.
func openTCP(ctx context.Context, addr string, limit time.Duration) (*net.TCPConn, *Error) {
	dialCtx, cancel := context.WithTimeout(ctx, limit)
	raw, err := (&net.Dialer{}).DialContext(dialCtx, "tcp", addr)
	timedOut := dialCtx.Err() == context.DeadlineExceeded && ctx.Err() == nil
	cancel()
	if err != nil {
		switch {
		case ctx.Err() != nil:
			return nil, &Error{Cause: Cancelled, Phase: Connecting, Err: ctx.Err()}
		case timedOut:
			return nil, &Error{Cause: TimedOut, Phase: Connecting, Err: err}
		case errors.Is(err, syscall.ECONNREFUSED) || isErrno(err, 10061):
			return nil, &Error{Cause: Refused, Phase: Connecting, Err: err}
		case errors.Is(err, syscall.ECONNRESET) || isErrno(err, 10054):
			return nil, &Error{Cause: Reset, Phase: Connecting, Err: err}
		default:
			return nil, &Error{Cause: Unreachable, Phase: Connecting, Err: err}
		}
	}
	tcp := raw.(*net.TCPConn)
	// The operating system's own patience with a silent link: what ends a link that never comes back (B8).
	if err := patience.Set(tcp, patience.Default); err != nil {
		_ = tcp.Close()
		return nil, &Error{Cause: Protocol, Phase: Connecting, Err: err}
	}
	return tcp, nil
}

// Details says what was agreed with the box.
func (l *Link) Details() Details { return l.details }

// RefusedChannels counts the channels the box tried to open on us. Each was refused.
func (l *Link) RefusedChannels() int64 { return l.refused.Load() }

// Conn is the SSH connection, for opening the shell and the file channel.
func (l *Link) Conn() ssh.Conn { return l.conn }

// Done is closed when the link has ended; End then says why.
func (l *Link) Done() <-chan struct{} { return l.done }

// End says why the link ended. Only valid after Done is closed.
func (l *Link) End() *Error { return l.endErr }

// Close ends the link from our side.
func (l *Link) Close() { _ = l.conn.Close() }

// testHookConnected lets a test look at the raw connection the link runs over.
var testHookConnected func(*net.TCPConn)

var errIdentity = errors.New("the box showed a key that is not the pinned one")

// attempt tracks the phase of one Dial and owns its timer.
type attempt struct {
	mu      sync.Mutex
	conn    *net.TCPConn
	phase   Phase
	timer   *time.Timer
	ended   Cause // set by a timer or a cancel: why we closed the connection ourselves
	endedIn Phase
	got     ssh.PublicKey
	seen    ssh.PublicKey // Identify: the key the box proved it holds
	wire    *wire
	signErr error // our signer failed: the cause is on our side, whatever the library then reports
	onPhase func(Phase)
}

// watch wraps the signer so that its own failure is known as such. The wrapper keeps the signer's say over
// which algorithm is used, when it has one.
func (a *attempt) watch(s ssh.Signer) ssh.Signer {
	w := watched{Signer: s, a: a}
	if m, ok := s.(ssh.MultiAlgorithmSigner); ok {
		return watchedMulti{watched: w, multi: m}
	}
	return w
}

type watched struct {
	ssh.Signer
	a *attempt
}

func (w watched) note(err error) {
	if err != nil {
		w.a.mu.Lock()
		w.a.signErr = err
		w.a.mu.Unlock()
	}
}

func (w watched) Sign(r io.Reader, data []byte) (*ssh.Signature, error) {
	sig, err := w.Signer.Sign(r, data)
	w.note(err)
	return sig, err
}

type watchedMulti struct {
	watched
	multi ssh.MultiAlgorithmSigner
}

func (w watchedMulti) Algorithms() []string { return w.multi.Algorithms() }

func (w watchedMulti) SignWithAlgorithm(r io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	sig, err := w.multi.SignWithAlgorithm(r, data, algorithm)
	w.note(err)
	return sig, err
}

func (a *attempt) tell(p Phase) {
	if a.onPhase != nil {
		a.onPhase(p)
	}
}

func (a *attempt) enter(p Phase, limit time.Duration) {
	a.mu.Lock()
	if a.ended != "" || a.phase == Up {
		a.mu.Unlock()
		return
	}
	if a.timer != nil {
		a.timer.Stop()
	}
	a.phase = p
	a.timer = time.AfterFunc(limit, func() { a.endIf(p, TimedOut) })
	a.mu.Unlock()
	a.tell(p)
}

// endIf closes the connection for cause, if the attempt is still in phase p.
func (a *attempt) endIf(p Phase, cause Cause) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ended != "" || a.phase != p {
		return
	}
	a.ended, a.endedIn = cause, a.phase
	_ = a.conn.Close()
}

func (a *attempt) end(cause Cause) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ended != "" || a.phase == Up {
		return
	}
	a.ended, a.endedIn = cause, a.phase
	if a.timer != nil {
		a.timer.Stop()
	}
	_ = a.conn.Close()
}

// stop ends the phase timer: the attempt is over and nothing more may close the connection for it.
func (a *attempt) stop() {
	a.mu.Lock()
	if a.timer != nil {
		a.timer.Stop()
	}
	a.mu.Unlock()
}

// finish marks the link up and stops the timer. False if the attempt was already ended by us.
func (a *attempt) finish() bool {
	a.mu.Lock()
	if a.timer != nil {
		a.timer.Stop()
	}
	if a.ended != "" {
		a.mu.Unlock()
		return false
	}
	a.phase = Up
	a.mu.Unlock()
	a.tell(Up)
	return true
}

// explain turns the library's error into ours. What we did ourselves comes first: it is the true cause, and
// the library only saw a closed connection.
func (a *attempt) explain(err error) *Error {
	a.mu.Lock()
	if a.timer != nil {
		a.timer.Stop()
	}
	phase, ended, endedIn, got, signErr := a.phase, a.ended, a.endedIn, a.got, a.signErr
	a.mu.Unlock()

	var neg *ssh.AlgorithmNegotiationError
	switch {
	case ended != "":
		return &Error{Cause: ended, Phase: endedIn, Err: err}
	case got != nil:
		return &Error{Cause: IdentityChanged, Phase: phase, Got: got, Err: errIdentity}
	case signErr != nil:
		return &Error{Cause: NoSignature, Phase: phase, Err: signErr}
	case errors.As(err, &neg):
		// For a client the library calls our own list "supported" and the box's "requested".
		return &Error{Cause: WeakOffer, Phase: phase, What: whatOf(neg.What), Ours: neg.SupportedAlgorithms, Box: neg.RequestedAlgorithms, Err: err}
	case phase == SigningIn && strings.Contains(err.Error(), "unable to authenticate"):
		return &Error{Cause: SignInFailed, Phase: phase, Err: err}
	}
	if a.wire != nil {
		err = a.wire.firstError(err)
	}
	e := classifyEnd(err)
	e.Phase = phase
	return e
}

// wire is the raw connection under the SSH library. It remembers the first error the operating system gave
// that names a real cause (a reset, or its patience running out), from a read or a write.
type wire struct {
	*net.TCPConn
	mu    sync.Mutex
	cause error
}

func (w *wire) note(err error) {
	if err == nil || !(isResetErr(err) || isTimeoutErr(err)) {
		return
	}
	w.mu.Lock()
	if w.cause == nil {
		w.cause = err
	}
	w.mu.Unlock()
}

func (w *wire) Read(p []byte) (int, error) {
	n, err := w.TCPConn.Read(p)
	w.note(err)
	return n, err
}

func (w *wire) Write(p []byte) (int, error) {
	n, err := w.TCPConn.Write(p)
	w.note(err)
	return n, err
}

// firstError gives the remembered cause if there is one, otherwise what the library said.
func (w *wire) firstError(fallback error) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.cause != nil {
		return w.cause
	}
	return fallback
}

func isResetErr(err error) bool {
	return errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) || isErrno(err, 10054) || isErrno(err, 10053)
}

// The operating system gave up on a silent link: its patience (ten minutes, set by us) ran out.
func isTimeoutErr(err error) bool {
	return errors.Is(err, syscall.ETIMEDOUT) || isErrno(err, 10060)
}

func whatOf(libraryWord string) string {
	switch {
	case strings.Contains(libraryWord, "key exchange"):
		return "key exchange"
	case strings.Contains(libraryWord, "host key"):
		return "identity algorithm"
	case strings.Contains(libraryWord, "cipher"):
		return "cipher"
	}
	return libraryWord
}

func classifyEnd(err error) *Error {
	switch {
	case err == nil || errors.Is(err, io.EOF):
		return &Error{Cause: ClosedByBox, Phase: Up, Err: err}
	case isResetErr(err):
		return &Error{Cause: Reset, Phase: Up, Err: err}
	case isTimeoutErr(err):
		return &Error{Cause: SilentTooLong, Phase: Up, Err: err}
	case errors.Is(err, net.ErrClosed):
		return &Error{Cause: Cancelled, Phase: Up, Err: err}
	case strings.Contains(err.Error(), "disconnect"):
		return &Error{Cause: ClosedByBox, Phase: Up, Err: err}
	}
	return &Error{Cause: Protocol, Phase: Up, Err: err}
}

// Windows reports socket errors with its own numbers (WSAECONNRESET 10054, WSAECONNREFUSED 10061).
func isErrno(err error, n syscall.Errno) bool {
	var no syscall.Errno
	return errors.As(err, &no) && no == n
}

// algorithmsFor gives the identity algorithms to offer for a pinned key: its own family only, never SHA-1.
func algorithmsFor(pin ssh.PublicKey) ([]string, error) {
	switch pin.Type() {
	case ssh.KeyAlgoED25519:
		return []string{ssh.KeyAlgoED25519}, nil
	case ssh.KeyAlgoRSA:
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}, nil
	}
	return nil, errors.New("a pinned identity of a kind this app does not accept: " + pin.Type())
}
