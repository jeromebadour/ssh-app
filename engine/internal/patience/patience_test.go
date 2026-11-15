package patience

import (
	"errors"
	"net"
	"testing"
	"time"
)

func pair(t *testing.T) *net.TCPConn {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		if c, err := ln.Accept(); err == nil {
			t.Cleanup(func() { c.Close() })
		}
	}()
	c, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c.(*net.TCPConn)
}

// The operating system must hold the value we set: read back from the socket, not from our own memory.
func TestSetIsReadBackFromTheSystem(t *testing.T) {
	conn := pair(t)
	before, err := Get(conn)
	if errors.Is(err, ErrUnsupported) {
		t.Skip("no setting on this system")
	}
	if err != nil {
		t.Fatal(err)
	}
	if before == Default {
		t.Fatalf("the system default is already %v: this test would prove nothing", before)
	}
	if err := Set(conn, Default); err != nil {
		t.Fatal(err)
	}
	after, err := Get(conn)
	if err != nil || after != Default {
		t.Fatalf("read back %v (%v), want %v", after, err, Default)
	}
	if err := Set(conn, 90*time.Second); err != nil {
		t.Fatal(err)
	}
	if again, _ := Get(conn); again != 90*time.Second {
		t.Fatalf("read back %v after a second change, want 1m30s", again)
	}
}

func TestRefusesNonsense(t *testing.T) {
	conn := pair(t)
	for _, d := range []time.Duration{0, -time.Second, 999 * time.Millisecond, 25 * time.Hour} {
		if err := Set(conn, d); err == nil || errors.Is(err, ErrUnsupported) {
			t.Errorf("Set(%v) must be refused by this package, got %v", d, err)
		}
	}
}
