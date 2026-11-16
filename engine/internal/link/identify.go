package link

import (
	"context"
	"errors"
	"net"

	"golang.org/x/crypto/ssh"
)

// The identity algorithms asked of a box nobody has pinned yet, in order: ed25519, and RSA with SHA-2 only for
// a box that has no ed25519 identity (plan B2.2). Never SHA-1 RSA, never DSA, never ECDSA.
var identifyAlgorithms = []string{ssh.KeyAlgoED25519, ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}

var errSeenEnough = errors.New("the identity was taken; nothing more is asked of this box")

// Identify asks a box who it is, for the first-connection check (plan B2.3), and nothing else.
//
// It opens the connection and runs the key exchange with exactly what Dial offers. The key exchange has the
// box prove that it holds its identity key; once that proof has been checked, the connection is closed. No
// sign-in is attempted and no user name is sent: there is no signer here, no key of ours, and nothing a box
// could be given.
//
// The key returned is only what answered at this address, this time. It is not trusted by being returned: the
// caller compares it with what the box itself printed in a trusted place, and pins it only on a match.
func Identify(ctx context.Context, addr string, opt Options) (ssh.PublicKey, *Error) {
	if addr == "" {
		return nil, &Error{Cause: Protocol, Phase: Connecting, Err: errors.New("no box given")}
	}
	d := opt.Deadlines
	if d.Connect <= 0 {
		d.Connect = DefaultDeadlines.Connect
	}
	if d.KeyExchange <= 0 {
		d.KeyExchange = DefaultDeadlines.KeyExchange
	}
	a := &attempt{phase: Connecting, onPhase: opt.OnPhase}
	a.tell(Connecting)
	tcp, oerr := openTCP(ctx, addr, d.Connect)
	if oerr != nil {
		return nil, oerr
	}
	defer tcp.Close()
	a.conn = tcp
	if testHookConnected != nil {
		testHookConnected(tcp)
	}
	a.enter(KeyExchange, d.KeyExchange)
	stopWatch := context.AfterFunc(ctx, func() { a.end(Cancelled) })
	defer stopWatch()

	cfg := &ssh.ClientConfig{
		Config: ssh.Config{KeyExchanges: keyExchanges, Ciphers: ciphers, MACs: macs},
		// No user, no way to sign in: the callback below ends the handshake before sign-in could begin.
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			a.mu.Lock()
			a.seen = key
			a.mu.Unlock()
			return errSeenEnough
		},
		HostKeyAlgorithms: identifyAlgorithms,
	}
	w := &wire{TCPConn: tcp}
	a.wire = w
	conn, _, _, err := ssh.NewClientConn(w, addr, cfg)
	if err == nil {
		// Cannot happen: the callback refuses every key. If it ever did, nothing may be made of the connection.
		_ = conn.Close()
		return nil, &Error{Cause: Protocol, Phase: KeyExchange, Err: errors.New("the handshake went on past the identity")}
	}
	a.mu.Lock()
	seen, ended := a.seen, a.ended
	a.mu.Unlock()
	if seen == nil || ended != "" {
		return nil, a.explain(err)
	}
	a.stop()
	switch seen.Type() {
	case ssh.KeyAlgoED25519, ssh.KeyAlgoRSA:
		return seen, nil
	}
	return nil, &Error{Cause: Protocol, Phase: KeyExchange, Err: errors.New("the box showed an identity of a kind this app does not accept: " + seen.Type())}
}
