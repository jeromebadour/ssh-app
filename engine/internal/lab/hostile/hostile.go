// Package hostile is a lab tool, never part of the app: an SSH server that does what a test tells it to,
// including what no honest server does (plan B9, B10). The engine's link is tested against it: weak offers, a
// swapped identity, silence at each phase, and a box that tries to open channels back to the client.
package hostile

import (
	"errors"
	"net"
	"sync"

	"golang.org/x/crypto/ssh"
)

// Config is how the server behaves. The zero value of each field is the honest behaviour.
type Config struct {
	HostSigner   ssh.Signer    // the identity it shows; required
	MoreHosts    []ssh.Signer  // further identities of other kinds, as a real box has (one per kind)
	Accept       ssh.PublicKey // the one key it lets in; nil lets nobody in
	KeyExchanges []string      // what it offers; nil is the library's own list
	Ciphers      []string
	Banner       string // its sign-in text
	Silent       bool   // take the connection and never say a word
	StallSignIn  bool   // never answer a sign-in
	// Sessions makes it take terminal sessions, the way a box does, and remember exactly what it was asked
	// (Box.Sessions). Its "shell" sends back every byte it is given; the bytes "exit\n" end it with status 7.
	Sessions bool
	// OnUp runs once a client is signed in, with the connection: the place to try things against the client.
	OnUp func(conn *ssh.ServerConn)
	// Listen is where it listens; empty is a free local port.
	Listen string
}

// Box is a running server.
type Box struct {
	ln     net.Listener
	closed chan struct{}
	wg     sync.WaitGroup
	once   sync.Once
	mu     sync.Mutex
	conns  []net.Conn
	seen   []*Session
	tries  int // sign-in attempts of any kind, "none" included
	users  []string
	accept ssh.PublicKey // set by Accept: the key let in from then on
	live   []ssh.Channel // the sessions' channels that are open now
	quiet  bool          // Quiet: the shells send nothing back by themselves
	got    []byte        // every byte the shells were given since the last Received
}

// Quiet makes the shells stop sending back what they are given (true), or do so again (false).
func (b *Box) Quiet(on bool) {
	b.mu.Lock()
	b.quiet = on
	b.mu.Unlock()
}

// Print writes bytes to every open session, as a program on the box printing them.
func (b *Box) Print(p []byte) {
	b.mu.Lock()
	chans := append([]ssh.Channel(nil), b.live...)
	b.mu.Unlock()
	for _, ch := range chans {
		_, _ = ch.Write(p)
	}
}

// Received gives every byte the shells were given since it was last asked, and forgets them.
func (b *Box) Received() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.got
	b.got = nil
	return out
}

// Accept changes the one key the box lets in, from now on (as when a key is added to a real box).
func (b *Box) Accept(key ssh.PublicKey) {
	b.mu.Lock()
	b.accept = key
	b.mu.Unlock()
}

// SignInTries is how often anyone tried to sign in, in any way, and the user names they gave.
func (b *Box) SignInTries() (int, []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.tries, append([]string(nil), b.users...)
}

// Session is everything one terminal session asked of the box, in order.
type Session struct {
	Asked   []string // the request types, in the order they came
	Term    string
	Cols    uint32
	Rows    uint32
	Command string // the start command; empty for a plain shell
	Resizes [][2]uint32
}

// Sessions is a copy of what every session so far asked for.
func (b *Box) Sessions() []Session {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Session, len(b.seen))
	for i, s := range b.seen {
		out[i] = *s
		out[i].Asked = append([]string(nil), s.Asked...)
		out[i].Resizes = append([][2]uint32(nil), s.Resizes...)
	}
	return out
}

func (b *Box) session(nc ssh.NewChannel) {
	ch, reqs, err := nc.Accept()
	if err != nil {
		return
	}
	defer ch.Close()
	b.mu.Lock()
	s := &Session{}
	b.seen = append(b.seen, s)
	b.mu.Unlock()
	started := make(chan struct{})
	go func() {
		running := false
		for r := range reqs {
			b.mu.Lock()
			s.Asked = append(s.Asked, r.Type)
			ok := false
			switch r.Type {
			case "pty-req":
				var p struct {
					Term                   string
					Cols, Rows, Wide, High uint32
					Modes                  string
				}
				if ssh.Unmarshal(r.Payload, &p) == nil {
					s.Term, s.Cols, s.Rows, ok = p.Term, p.Cols, p.Rows, true
				}
			case "exec":
				var p struct{ Command string }
				if ssh.Unmarshal(r.Payload, &p) == nil && !running {
					s.Command, ok, running = p.Command, true, true
					close(started)
				}
			case "shell":
				if !running {
					ok, running = true, true
					close(started)
				}
			case "window-change":
				var p struct{ Cols, Rows, Wide, High uint32 }
				if ssh.Unmarshal(r.Payload, &p) == nil {
					s.Resizes = append(s.Resizes, [2]uint32{p.Cols, p.Rows})
					ok = true
				}
			}
			b.mu.Unlock()
			if r.WantReply {
				_ = r.Reply(ok, nil)
			}
		}
	}()
	select {
	case <-started:
	case <-b.closed:
		return
	}
	b.mu.Lock()
	b.live = append(b.live, ch)
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		for i, c := range b.live {
			if c == ch {
				b.live = append(b.live[:i], b.live[i+1:]...)
				break
			}
		}
		b.mu.Unlock()
	}()
	buf := make([]byte, 32*1024)
	var tail []byte
	for {
		n, err := ch.Read(buf)
		if n > 0 {
			b.mu.Lock()
			quiet := b.quiet
			if len(b.got) < 4<<20 {
				b.got = append(b.got, buf[:n]...)
			}
			b.mu.Unlock()
			if !quiet {
				if _, werr := ch.Write(buf[:n]); werr != nil {
					return
				}
			}
			tail = append(tail, buf[:n]...)
			if len(tail) > 5 {
				tail = tail[len(tail)-5:]
			}
			if string(tail) == "exit\n" {
				_, _ = ch.SendRequest("exit-status", false, []byte{0, 0, 0, 7})
				return
			}
		}
		if err != nil {
			return
		}
	}
}

// Start runs a server on a free local port.
func Start(cfg Config) (*Box, error) {
	if cfg.HostSigner == nil {
		return nil, errors.New("hostile: no identity given")
	}
	at := cfg.Listen
	if at == "" {
		at = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp4", at)
	if err != nil {
		return nil, err
	}
	b := &Box{ln: ln, closed: make(chan struct{}), accept: cfg.Accept}
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			b.mu.Lock()
			b.conns = append(b.conns, c)
			b.mu.Unlock()
			b.wg.Add(1)
			go func() { defer b.wg.Done(); b.serve(c, cfg) }()
		}
	}()
	return b, nil
}

// Addr is where it listens.
func (b *Box) Addr() string { return b.ln.Addr().String() }

// Close stops it and everything it started. Calling it again does nothing.
func (b *Box) Close() {
	b.once.Do(func() { close(b.closed) })
	_ = b.ln.Close()
	b.mu.Lock()
	for _, c := range b.conns {
		_ = c.Close()
	}
	b.mu.Unlock()
	b.wg.Wait()
}

func (b *Box) serve(c net.Conn, cfg Config) {
	defer c.Close()
	if cfg.Silent {
		<-b.closed
		return
	}
	sc := &ssh.ServerConfig{
		Config: ssh.Config{KeyExchanges: cfg.KeyExchanges, Ciphers: cfg.Ciphers},
		// Every sign-in attempt is written down, the first empty "none" attempt included.
		AuthLogCallback: func(m ssh.ConnMetadata, _ string, _ error) {
			b.mu.Lock()
			b.tries++
			b.users = append(b.users, m.User())
			b.mu.Unlock()
		},
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if cfg.StallSignIn {
				<-b.closed
			}
			b.mu.Lock()
			let := b.accept
			b.mu.Unlock()
			if let != nil && string(key.Marshal()) == string(let.Marshal()) {
				return &ssh.Permissions{}, nil
			}
			return nil, errors.New("not this key")
		},
	}
	if cfg.Banner != "" {
		sc.BannerCallback = func(ssh.ConnMetadata) string { return cfg.Banner }
	}
	sc.AddHostKey(cfg.HostSigner)
	for _, more := range cfg.MoreHosts {
		sc.AddHostKey(more)
	}
	conn, chans, reqs, err := ssh.NewServerConn(c, sc)
	if err != nil {
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)
	go func() {
		for ch := range chans {
			if cfg.Sessions && ch.ChannelType() == "session" {
				go b.session(ch)
				continue
			}
			_ = ch.Reject(ssh.UnknownChannelType, "not that")
		}
	}()
	if cfg.OnUp != nil {
		cfg.OnUp(conn)
	}
	_ = conn.Wait()
}
