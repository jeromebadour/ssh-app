// Package faultproxy is a lab tool, never part of the app: a TCP relay that sits between the engine and an SSH
// server in tests and misbehaves on command, the way real links do (plan B9). It can slow a link down, hold it
// silent and let it come back with nothing lost, end it with a reset, and refuse new connections.
//
// A held link is the case the app exists for. The relay keeps both TCP connections open and acknowledged and
// simply stops passing bytes, so each end sees a peer that is there and says nothing: what a dropped home
// connection looks like to an SSH session for the first minutes.
package faultproxy

import (
	"errors"
	"io"
	"math/rand/v2"
	"net"
	"sync"
	"time"
)

// Faults is how the relay behaves from now on. It applies to connections already open and to new ones.
type Faults struct {
	Delay     time.Duration // added to every chunk, each way
	Jitter    time.Duration // up to this much more, at random; order is always kept
	Hold      bool          // pass nothing either way; connections stay open; bytes wait and are not lost
	RefuseNew bool          // a new connection is reset at once
}

const (
	chunkSize  = 32 * 1024
	queueDepth = 64 // chunks waiting per direction; beyond that the sender is made to wait, as on a real link
)

// Proxy relays every connection made to Addr on to one target.
type Proxy struct {
	target string
	ln     *net.TCPListener

	mu      sync.Mutex
	changed *sync.Cond
	faults  Faults
	closed  bool
	resets  int
	conns   map[*net.TCPConn]struct{}
	wg      sync.WaitGroup
}

// Listen starts a relay to target on a free local port.
func Listen(target string) (*Proxy, error) {
	ln, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, err
	}
	p := &Proxy{target: target, ln: ln, conns: map[*net.TCPConn]struct{}{}}
	p.changed = sync.NewCond(&p.mu)
	p.wg.Add(1)
	go p.accept()
	return p, nil
}

// Addr is where clients connect.
func (p *Proxy) Addr() string { return p.ln.Addr().String() }

// Set changes the behaviour, for open connections too.
func (p *Proxy) Set(f Faults) {
	p.mu.Lock()
	p.faults = f
	p.mu.Unlock()
	p.changed.Broadcast()
}

// Reset ends every open connection the hard way: both ends get a TCP reset, not a clean close.
func (p *Proxy) Reset() {
	p.mu.Lock()
	p.resets++
	for c := range p.conns {
		_ = c.SetLinger(0)
		_ = c.Close()
	}
	p.mu.Unlock()
	p.changed.Broadcast()
}

// Open says how many client connections are being relayed now.
func (p *Proxy) Open() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.conns) / 2
}

// Close stops the relay and waits until everything it started has ended.
func (p *Proxy) Close() {
	p.mu.Lock()
	p.closed = true
	for c := range p.conns {
		_ = c.Close()
	}
	p.mu.Unlock()
	p.changed.Broadcast()
	_ = p.ln.Close()
	p.wg.Wait()
}

func (p *Proxy) accept() {
	defer p.wg.Done()
	for {
		client, err := p.ln.AcceptTCP()
		if err != nil {
			return
		}
		p.mu.Lock()
		refuse, closed := p.faults.RefuseNew, p.closed
		p.mu.Unlock()
		if refuse || closed {
			_ = client.SetLinger(0)
			_ = client.Close()
			continue
		}
		p.wg.Add(1)
		go p.relay(client)
	}
}

func (p *Proxy) relay(client *net.TCPConn) {
	defer p.wg.Done()
	up, err := net.DialTimeout("tcp", p.target, 10*time.Second)
	if err != nil {
		_ = client.SetLinger(0)
		_ = client.Close()
		return
	}
	server := up.(*net.TCPConn)
	if !p.track(client, server) {
		_ = client.Close()
		_ = server.Close()
		return
	}
	var pair sync.WaitGroup
	pair.Add(2)
	go func() { defer pair.Done(); p.pipe(client, server) }()
	go func() { defer pair.Done(); p.pipe(server, client) }()
	pair.Wait()
	p.untrack(client, server)
}

func (p *Proxy) track(a, b *net.TCPConn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false
	}
	p.conns[a], p.conns[b] = struct{}{}, struct{}{}
	return true
}

func (p *Proxy) untrack(a, b *net.TCPConn) {
	_ = a.Close()
	_ = b.Close()
	p.mu.Lock()
	delete(p.conns, a)
	delete(p.conns, b)
	p.mu.Unlock()
}

type chunk struct {
	data []byte
	due  time.Time
	end  error // set on the last chunk: how the reading side ended
}

// pipe moves bytes one way. A reader stamps each chunk with the moment it may leave; a writer sends them in
// order, never before that moment and never while the link is held. When the reading side ends, the other side
// is told the way it happened: a clean end is passed on as a clean end (and the other direction goes on), a
// reset as a reset.
func (p *Proxy) pipe(from, to *net.TCPConn) {
	gen := p.generation()
	queue := make(chan chunk, queueDepth)
	go func() {
		defer close(queue)
		var last time.Time
		for {
			buf := make([]byte, chunkSize)
			n, err := from.Read(buf)
			if n > 0 {
				f := p.current()
				due := time.Now().Add(f.Delay)
				if f.Jitter > 0 {
					due = due.Add(time.Duration(rand.Int64N(int64(f.Jitter))))
				}
				if due.Before(last) {
					due = last
				}
				last = due
				queue <- chunk{data: buf[:n], due: due}
			}
			if err != nil {
				queue <- chunk{end: err}
				return
			}
		}
	}()

	stopped := false
	stop := func(reset bool) {
		// If Reset was called meanwhile, this end is a reset too, whichever of the two connections it reached
		// first: closing the other one cleanly here would turn the reset into a polite goodbye.
		if reset || p.generation() != gen {
			_ = to.SetLinger(0)
		}
		_ = to.Close()
		_ = from.Close()
		stopped = true
	}
	for c := range queue {
		if stopped {
			continue // drain, so the reader can end
		}
		if c.end != nil {
			switch {
			case errors.Is(c.end, io.EOF):
				_ = to.CloseWrite()
			case errors.Is(c.end, net.ErrClosed):
				stop(false)
			default:
				stop(true)
			}
			continue
		}
		if d := time.Until(c.due); d > 0 {
			time.Sleep(d)
		}
		if !p.waitWhileHeld(gen) {
			stop(false)
			continue
		}
		if _, err := to.Write(c.data); err != nil {
			stop(false)
		}
	}
}

func (p *Proxy) current() Faults {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.faults
}

func (p *Proxy) generation() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.resets
}

// waitWhileHeld returns true once the link is not held. It returns false if the relay was closed, or its
// connections reset, meanwhile.
func (p *Proxy) waitWhileHeld(gen int) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for p.faults.Hold && !p.closed && p.resets == gen {
		p.changed.Wait()
	}
	return !p.closed && p.resets == gen
}
