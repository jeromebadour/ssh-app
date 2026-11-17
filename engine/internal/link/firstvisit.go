package link

// The first visit to a box that holds no key of ours at all (decision O2, plan B2.5 entry 5).
//
// Berth signs in with a key and nothing else, everywhere, always. This is the one exception, and it exists for
// one reason: a new machine arrives as an address, a user and a password, and an app that cannot get in there
// is not a replacement for the app that can. So: one sign-in, with a password a person has just typed, used to
// put Berth's own key on the box, and then never again.
//
// The order is the whole of the argument. The identity is pinned before this is called, and the pinned key is
// required here: a box that is not the one he checked never sees the password. Built the other way round, this
// would be a way to hand a password to a machine pretending to be his.
//
// What may be run is not a parameter a caller chooses freely in spirit: it is the block from
// protocol/first-connection.json, which main holds and fills in with the box's own public key. Nothing else is
// ever run on this sign-in, and the session is closed the moment it is done.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"time"

	"golang.org/x/crypto/ssh"
)

// How long the whole of a first visit may take: connect, sign in, run one short command, close.
const FirstVisitDeadline = 2 * time.Minute

// What the box may print back. The block prints a few fingerprint lines; a box that sends more than this is
// not answering the question that was asked.
const firstVisitOutputMax = 64 << 10

// ErrAskedSomethingElse is a box that wants more than a password at this moment: a code from a phone, an
// answer to a question of its own. Berth cannot answer that here, and says so rather than failing as though
// the password were wrong.
var ErrAskedSomethingElse = errors.New("link: the box asked for something a password cannot answer")

// FirstVisit signs in once with a password, runs the one command it is given, and closes. It returns what the
// box printed. The password is held only for the length of this call.
func FirstVisit(ctx context.Context, t Target, password string, command string, opt Options) (string, *Error) {
	if t.HostKey == nil || t.User == "" || t.Addr == "" {
		return "", &Error{Cause: Protocol, Phase: Connecting, Err: errors.New("no box, user or pinned identity given")}
	}
	if password == "" || command == "" {
		return "", &Error{Cause: Protocol, Phase: SigningIn, Err: errors.New("no password or nothing to run")}
	}
	identityAlgos, err := algorithmsFor(t.HostKey)
	if err != nil {
		return "", &Error{Cause: Protocol, Phase: Connecting, Err: err}
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
		return "", oerr
	}
	a.conn = tcp
	a.enter(KeyExchange, d.KeyExchange)
	stopWatch := context.AfterFunc(ctx, func() { a.end(Cancelled) })
	defer stopWatch()

	banner := &bannerBudget{left: BannerMax}
	// A box that wants something a password cannot answer is told apart from a wrong password, because the two
	// are different things to a person and only one of them is worth typing again.
	askedElse := false
	cfg := &ssh.ClientConfig{
		Config: ssh.Config{KeyExchanges: keyExchanges, Ciphers: ciphers, MACs: macs},
		User:   t.User,
		Auth: []ssh.AuthMethod{
			ssh.Password(password),
			// Some boxes ask for the password through the question-and-answer method instead. One question,
			// with its echo off, is that password being asked for under another name, and is answered. Two
			// questions, or one whose answer is meant to be read off a phone, is not something this can
			// answer, and it says so.
			ssh.KeyboardInteractive(func(_, _ string, questions []string, echos []bool) ([]string, error) {
				if len(questions) == 0 {
					return nil, nil // some boxes open with nothing to ask
				}
				if len(questions) != 1 || (len(echos) == 1 && echos[0]) {
					askedElse = true
					return nil, ErrAskedSomethingElse
				}
				return []string{password}, nil
			}),
		},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if !bytes.Equal(key.Marshal(), t.HostKey.Marshal()) {
				a.got = key
				return errIdentity
			}
			return nil
		},
		HostKeyAlgorithms: identityAlgos,
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
	cfg.Auth[0] = passwordOnce(a, d.SignIn, password)

	w := &wire{TCPConn: tcp}
	a.wire = w
	conn, chans, reqs, cerr := ssh.NewClientConn(w, t.Addr, cfg)
	if cerr != nil {
		_ = tcp.Close()
		e := a.explain(cerr)
		if askedElse {
			e.Err = ErrAskedSomethingElse
		}
		return "", e
	}
	if !a.finish() {
		_ = conn.Close()
		return "", a.explain(errors.New("ended as it came up"))
	}
	client := ssh.NewClient(conn, chans, reqs)
	defer client.Close()

	// One session, one command, its own deadline, and then the whole link goes. Nothing is left open: this
	// sign-in exists for one command and must not be a way into a shell.
	stop := context.AfterFunc(ctx, func() { _ = client.Close() })
	defer stop()
	timer := time.AfterFunc(FirstVisitDeadline, func() { _ = client.Close() })
	defer timer.Stop()

	session, serr := client.NewSession()
	if serr != nil {
		return "", &Error{Cause: Protocol, Phase: Up, Err: serr}
	}
	defer session.Close()
	var said bytes.Buffer
	session.Stdout = &capped{to: &said, left: firstVisitOutputMax}
	session.Stderr = &capped{to: &said, left: firstVisitOutputMax}
	if rerr := session.Run(command); rerr != nil {
		return said.String(), &Error{Cause: Protocol, Phase: Up, Err: rerr}
	}
	return said.String(), nil
}

// capped takes at most what is left and drops the rest, so a box cannot answer a short command with a stream
// that never ends.
type capped struct {
	to   io.Writer
	left int
}

// It always says it took the whole of what it was given, because a writer that says it took less is a short
// write, and the library's own copying turns a short write into an error. What is past the cap is dropped, not
// refused: the command has already run, and the answer being long is not a failure of the visit.
func (c *capped) Write(p []byte) (int, error) {
	whole := len(p)
	if c.left <= 0 {
		return whole, nil
	}
	if len(p) > c.left {
		p = p[:c.left]
	}
	c.left -= len(p)
	if _, err := c.to.Write(p); err != nil {
		return whole, err
	}
	return whole, nil
}

// The password is offered once and once only. The library would otherwise offer it again on a second round,
// and a box that refuses it twice is a box that counts two wrong passwords against the account.
func passwordOnce(a *attempt, deadline time.Duration, password string) ssh.AuthMethod {
	return ssh.PasswordCallback(offerOnce(password, func() { a.enter(SigningIn, deadline) }))
}

// The once-only part on its own, so it can be read and tested without a box at the other end.
func offerOnce(password string, before func()) func() (string, error) {
	used := false
	return func() (string, error) {
		if used {
			return "", errors.New("the password was already offered once")
		}
		used = true
		if before != nil {
			before()
		}
		return password, nil
	}
}
