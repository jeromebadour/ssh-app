package faultproxy

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"io"
	"net"
	"runtime"
	"syscall"
	"testing"
	"time"
)

// An echo server: everything a client sends comes back.
func echo(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(c, c); _ = c.Close() }()
		}
	}()
	return ln.Addr().String()
}

func start(t *testing.T) (*Proxy, net.Conn) {
	t.Helper()
	p, err := Listen(echo(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	c := dial(t, p)
	// Connected is not yet relayed: wait until the relay has taken the connection up.
	waitFor(t, "the relay to take the connection up", func() bool { return p.Open() == 1 })
	return p, c
}

func dial(t *testing.T, p *Proxy) net.Conn {
	t.Helper()
	c, err := net.DialTimeout("tcp", p.Addr(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// Sends data and reads the same amount back, returning what came and how long the first byte took.
func roundTrip(t *testing.T, c net.Conn, data []byte, limit time.Duration) ([]byte, time.Duration) {
	t.Helper()
	began := time.Now()
	go func() { _, _ = c.Write(data) }()
	got := make([]byte, len(data))
	_ = c.SetReadDeadline(time.Now().Add(limit))
	if _, err := io.ReadFull(c, got[:1]); err != nil {
		t.Fatalf("nothing came back: %v", err)
	}
	first := time.Since(began)
	if _, err := io.ReadFull(c, got[1:]); err != nil {
		t.Fatalf("the rest did not come back: %v", err)
	}
	return got, first
}

func TestBytesPassUnchangedBothWays(t *testing.T) {
	_, c := start(t)
	data := make([]byte, 8<<20)
	_, _ = rand.Read(data)
	got, _ := roundTrip(t, c, data, 30*time.Second)
	if sha256.Sum256(got) != sha256.Sum256(data) {
		t.Fatal("8 MiB came back changed")
	}
}

func TestDelayEachWay(t *testing.T) {
	p, c := start(t)
	p.Set(Faults{Delay: 150 * time.Millisecond})
	_, first := roundTrip(t, c, []byte("ping"), 5*time.Second)
	if first < 300*time.Millisecond || first > 900*time.Millisecond {
		t.Fatalf("150 ms each way gave a round trip of %v", first)
	}
	p.Set(Faults{})
	if _, first = roundTrip(t, c, []byte("ping"), 5*time.Second); first > 100*time.Millisecond {
		t.Fatalf("with the delay taken away the round trip is still %v", first)
	}
}

func TestJitterKeepsTheOrder(t *testing.T) {
	p, c := start(t)
	p.Set(Faults{Delay: 5 * time.Millisecond, Jitter: 40 * time.Millisecond})
	var want bytes.Buffer
	go func() {
		for i := 0; i < 200; i++ {
			_, _ = c.Write([]byte{byte(i)})
			time.Sleep(time.Millisecond)
		}
	}()
	for i := 0; i < 200; i++ {
		want.WriteByte(byte(i))
	}
	got := make([]byte, 200)
	_ = c.SetReadDeadline(time.Now().Add(20 * time.Second))
	if _, err := io.ReadFull(c, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want.Bytes()) {
		t.Fatal("bytes arrived out of order")
	}
}

// A held link: both ends stay connected, nothing passes, and when it comes back nothing was lost.
func TestHoldThenComeBack(t *testing.T) {
	p, c := start(t)
	roundTrip(t, c, []byte("before"), 5*time.Second)
	p.Set(Faults{Hold: true})
	if _, err := c.Write([]byte("during the silence")); err != nil {
		t.Fatalf("a held link refused a write: %v", err)
	}
	_ = c.SetReadDeadline(time.Now().Add(700 * time.Millisecond))
	one := make([]byte, 1)
	if _, err := c.Read(one); !errors.Is(err, errTimeout(err)) || err == nil {
		t.Fatalf("a held link let something through, or ended: %v", err)
	}
	if p.Open() != 1 {
		t.Fatalf("the held connection is no longer open: %d", p.Open())
	}
	p.Set(Faults{})
	got := make([]byte, len("during the silence"))
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(c, got); err != nil || string(got) != "during the silence" {
		t.Fatalf("after the link came back: %q %v", got, err)
	}
}

// errTimeout returns err itself when it is a timeout, so errors.Is above reads as "is a timeout".
func errTimeout(err error) error {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return err
	}
	return errors.New("not a timeout")
}

func TestResetIsAReset(t *testing.T) {
	for _, held := range []bool{false, true} {
		p, c := start(t)
		roundTrip(t, c, []byte("before"), 5*time.Second)
		p.Set(Faults{Hold: held})
		p.Reset()
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, err := c.Read(make([]byte, 1))
		if !isReset(err) {
			t.Fatalf("held=%v: wanted a connection reset, got %v", held, err)
		}
		waitFor(t, "the reset connection to be let go", func() bool { return p.Open() == 0 })
		// The relay itself goes on: a new connection works.
		p.Set(Faults{})
		roundTrip(t, dial(t, p), []byte("after"), 5*time.Second)
	}
}

func TestRefuseNew(t *testing.T) {
	p, c := start(t)
	p.Set(Faults{RefuseNew: true})
	roundTrip(t, c, []byte("the open one goes on"), 5*time.Second)
	n, err := net.DialTimeout("tcp", p.Addr(), 5*time.Second)
	if err == nil {
		_ = n.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, err = n.Read(make([]byte, 1))
		_ = n.Close()
	}
	if !isReset(err) && !isRefused(err) {
		t.Fatalf("a refused connection ended with %v", err)
	}
}

// A clean end from the client is passed on as a clean end, and what the server still had to say arrives.
func TestCleanEndIsPassedOn(t *testing.T) {
	_, c := start(t)
	if _, err := c.Write([]byte("last words")); err != nil {
		t.Fatal(err)
	}
	_ = c.(*net.TCPConn).CloseWrite()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	got, err := io.ReadAll(c)
	if err != nil || string(got) != "last words" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestTargetNotThere(t *testing.T) {
	ln, _ := net.Listen("tcp4", "127.0.0.1:0")
	gone := ln.Addr().String()
	_ = ln.Close()
	p, err := Listen(gone)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	// The reset can land while still connecting, or at the first read.
	c, err := net.DialTimeout("tcp", p.Addr(), 5*time.Second)
	if err == nil {
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, err = c.Read(make([]byte, 1))
		_ = c.Close()
	}
	if !isReset(err) {
		t.Fatalf("with no target behind it: %v", err)
	}
}

// Close ends everything it started, held connections included.
func TestCloseLeavesNothingRunning(t *testing.T) {
	before := runtime.NumGoroutine()
	target := echo(t)
	for i := 0; i < 5; i++ {
		p, err := Listen(target)
		if err != nil {
			t.Fatal(err)
		}
		a, b := dial(t, p), dial(t, p)
		roundTrip(t, a, []byte("x"), 5*time.Second)
		roundTrip(t, b, []byte("y"), 5*time.Second)
		p.Set(Faults{Hold: i%2 == 0, Delay: 20 * time.Millisecond})
		_, _ = a.Write([]byte("left in the queue"))
		p.Close()
		_ = a.Close()
		_ = b.Close()
	}
	waitFor(t, "every goroutine the relays started to end", func() bool { return runtime.NumGoroutine() <= before+2 })
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("waited 5 s for %s", what)
}

// Windows reports these with its own numbers (WSAECONNRESET 10054, WSAECONNREFUSED 10061).
func isReset(err error) bool {
	var no syscall.Errno
	return errors.Is(err, syscall.ECONNRESET) || (errors.As(err, &no) && no == 10054)
}

func isBrokenPipe(err error) bool { return errors.Is(err, syscall.EPIPE) }

func isRefused(err error) bool {
	var no syscall.Errno
	return errors.Is(err, syscall.ECONNREFUSED) || (errors.As(err, &no) && no == 10061)
}
