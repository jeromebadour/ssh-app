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
	Accept       ssh.PublicKey // the one key it lets in; nil lets nobody in
	KeyExchanges []string      // what it offers; nil is the library's own list
	Ciphers      []string
	Banner       string // its sign-in text
	Silent       bool   // take the connection and never say a word
	StallSignIn  bool   // never answer a sign-in
	// OnUp runs once a client is signed in, with the connection: the place to try things against the client.
	OnUp func(conn *ssh.ServerConn)
}

// Box is a running server.
type Box struct {
	ln     net.Listener
	closed chan struct{}
	wg     sync.WaitGroup
	once   sync.Once
	mu     sync.Mutex
	conns  []net.Conn
}

// Start runs a server on a free local port.
func Start(cfg Config) (*Box, error) {
	if cfg.HostSigner == nil {
		return nil, errors.New("hostile: no identity given")
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	b := &Box{ln: ln, closed: make(chan struct{})}
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
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if cfg.StallSignIn {
				<-b.closed
			}
			if cfg.Accept != nil && string(key.Marshal()) == string(cfg.Accept.Marshal()) {
				return &ssh.Permissions{}, nil
			}
			return nil, errors.New("not this key")
		},
	}
	if cfg.Banner != "" {
		sc.BannerCallback = func(ssh.ConnMetadata) string { return cfg.Banner }
	}
	sc.AddHostKey(cfg.HostSigner)
	conn, chans, reqs, err := ssh.NewServerConn(c, sc)
	if err != nil {
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)
	go func() {
		for ch := range chans {
			_ = ch.Reject(ssh.UnknownChannelType, "not yet")
		}
	}()
	if cfg.OnUp != nil {
		cfg.OnUp(conn)
	}
	_ = conn.Wait()
}
