// Package hostile is a lab tool, never part of the app: an SSH server that does what a test tells it to,
// including what no honest server does (plan B9, B10). The engine's link is tested against it: weak offers, a
// swapped identity, silence at each phase, and a box that tries to open channels back to the client.
package hostile

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

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
	// FilesUnder makes it answer the file protocol on a "subsystem" request for sftp, backed by this real
	// folder. Empty means it has no file subsystem at all, which is a thing a real box can be too.
	FilesUnder string
	// OnUp runs once a client is signed in, with the connection: the place to try things against the client.
	OnUp func(conn *ssh.ServerConn)
	// Listen is where it listens; empty is a free local port.
	Listen string
}

// Box is a running server.
type Box struct {
	ln          net.Listener
	closed      chan struct{}
	wg          sync.WaitGroup
	once        sync.Once
	mu          sync.Mutex
	conns       []net.Conn
	seen        []*Session
	tries       int // sign-in attempts of any kind, "none" included
	users       []string
	accept      ssh.PublicKey // set by Accept: the key let in from then on
	live        []*out        // the sessions that are open now: each one's way out
	quiet       bool          // Quiet: the shells send nothing back by themselves
	stall       bool          // Stall: a sign-in is never answered, as a box that has stopped halfway
	got         []byte        // every byte the shells were given since the last Received
	files       string        // the folder its file subsystem answers under; empty means it has none
	refuseFiles int           // how many more times to say no to the file subsystem, for the lab
	flood       atomic.Int64  // Flood: bytes the sessions took, in all
}

// out is one session's way out. Its shell, Print and Flood take turns writing: the library's channel must not be
// written from two goroutines at once (they would share one packet buffer, and the client would be sent a
// packet that says one length and holds another; found 2026-11-16, when Flood first printed beside the shell).
type out struct {
	mu sync.Mutex
	ch ssh.Channel
}

func (o *out) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.ch.Write(p)
}

// Hold makes every connection go silent for a while, both ways, with both ends still connected: what is sent
// to it is not read and nothing comes back, and when the hold is over everything that was waiting goes
// through, in order, nothing lost. That is a network that stopped carrying, the case this app exists for.
func (b *Box) Hold(d time.Duration) int {
	b.mu.Lock()
	conns := append([]net.Conn(nil), b.conns...)
	b.mu.Unlock()
	held := 0
	for _, c := range conns {
		if h, ok := c.(*heldConn); ok {
			h.hold(d)
			held++
		}
	}
	return held
}

// Reset ends every connection the way a network does when it drops the other end: a real reset, not a polite
// goodbye. Both are endings, and a client must tell them apart.
func (b *Box) Reset() int {
	b.mu.Lock()
	conns := append([]net.Conn(nil), b.conns...)
	b.conns = nil
	b.mu.Unlock()
	for _, c := range conns {
		if h, ok := c.(*heldConn); ok {
			if tcp, ok := h.Conn.(*net.TCPConn); ok {
				_ = tcp.SetLinger(0)
			}
		}
		_ = c.Close()
	}
	return len(conns)
}

// Stall makes sign-ins go unanswered from now on (true), or answered again (false), as a box whose disk has
// stopped: the connection is up, the key exchange is done, and nothing comes back.
func (b *Box) Stall(on bool) {
	b.mu.Lock()
	b.stall = on
	b.mu.Unlock()
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
	chans := append([]*out(nil), b.live...)
	b.mu.Unlock()
	for _, ch := range chans {
		_, _ = ch.Write(p)
	}
}

// Flood makes every open session print for the given time: lines of a log with a colour here and there, the way
// a busy program prints. perSecond is how many bytes each session prints a second; 0 is as fast as its client
// takes it. It returns at once with how many sessions print. Each stops by itself; a client that takes nothing
// just makes its session wait, as a real box's program would.
func (b *Box) Flood(d time.Duration, perSecond int) int {
	b.mu.Lock()
	chans := append([]*out(nil), b.live...)
	b.mu.Unlock()
	block := make([]byte, 0, 40*1024)
	for i := 0; len(block) < 32*1024; i++ {
		line := fmt.Sprintf("2026-11-16T07:%02d:%02d.%03dZ worker-%d \x1b[32mok\x1b[0m   request %08x served in %d ms, %d bytes, cache %s\r\n", i%60, (i*7)%60, (i*37)%1000, i%8, i*2654435761, 3+i%40, 512+i*97%9000, []string{"hit", "miss", "stale"}[i%3])
		if i%29 == 0 {
			line = fmt.Sprintf("2026-11-16T07:%02d:%02d.%03dZ worker-%d \x1b[33mwarn\x1b[0m retry %d of 5 for /var/lib/app/queue/%06d.job\r\n", i%60, (i*7)%60, (i*37)%1000, i%8, 1+i%5, i)
		}
		block = append(block, line...)
	}
	began := time.Now()
	until := began.Add(d)
	piece := len(block)
	if perSecond > 0 && perSecond/50 < piece {
		piece = max(256, perSecond/50) // about fifty pieces a second, so the pace is even
	}
	for _, ch := range chans {
		go func(ch *out) {
			sent := 0
			// The block goes round and round, piece after piece, so what is printed is always whole lines.
			for at := 0; time.Now().Before(until); {
				n, err := ch.Write(block[at:min(at+piece, len(block))])
				b.flood.Add(int64(n))
				sent += n
				at = (at + n) % len(block)
				if err != nil {
					return
				}
				if perSecond > 0 {
					// Never ahead of the pace: wait until this much is due.
					if due := began.Add(time.Duration(float64(sent) / float64(perSecond) * float64(time.Second))); time.Until(due) > 0 {
						time.Sleep(time.Until(due))
					}
				}
			}
		}(ch)
	}
	return len(chans)
}

// Flooded is how many bytes the sessions took from Flood, in all.
func (b *Box) Flooded() int64 { return b.flood.Load() }

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
// RefuseFiles makes the box say no to the next n asks for its file subsystem.
func (b *Box) RefuseFiles(n int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refuseFiles = n
}

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
			case "subsystem":
				var p struct{ Name string }
				// A box that says no to the file subsystem this once: a real box does, when it is busy or when
				// the link is barely up, and the app has to live through it rather than treat it as the end.
				if b.refuseFiles > 0 {
					b.refuseFiles--
				} else if ssh.Unmarshal(r.Payload, &p) == nil && p.Name == "sftp" && b.files != "" && !running {
					ok, running = true, true
					go serveFiles(ch, b.files)
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
	way := &out{ch: ch}
	b.mu.Lock()
	b.live = append(b.live, way)
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		for i, c := range b.live {
			if c == way {
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
				if _, werr := way.Write(buf[:n]); werr != nil {
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

// heldConn is a connection that can be made to go silent for a while: reads and writes wait, and nothing is
// lost or reordered. The operating system's own buffers hold what the other end sends meanwhile, as they do
// when a network stops carrying.
type heldConn struct {
	net.Conn
	mu    sync.Mutex
	until time.Time
}

func (h *heldConn) hold(d time.Duration) {
	h.mu.Lock()
	h.until = time.Now().Add(d)
	h.mu.Unlock()
}

func (h *heldConn) wait() {
	for {
		h.mu.Lock()
		left := time.Until(h.until)
		h.mu.Unlock()
		if left <= 0 {
			return
		}
		time.Sleep(min(left, 25*time.Millisecond))
	}
}

func (h *heldConn) Read(p []byte) (int, error) {
	h.wait()
	return h.Conn.Read(p)
}

func (h *heldConn) Write(p []byte) (int, error) {
	h.wait()
	return h.Conn.Write(p)
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
	b := &Box{ln: ln, closed: make(chan struct{}), accept: cfg.Accept, files: cfg.FilesUnder}
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			b.mu.Lock()
			held := &heldConn{Conn: c}
			b.conns = append(b.conns, net.Conn(held))
			b.mu.Unlock()
			b.wg.Add(1)
			go func() { defer b.wg.Done(); b.serve(held, cfg) }()
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
			b.mu.Lock()
			stall := cfg.StallSignIn || b.stall
			b.mu.Unlock()
			if stall {
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
