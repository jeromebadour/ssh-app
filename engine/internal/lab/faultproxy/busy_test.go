package faultproxy

import (
	"testing"
	"time"
)

// A reset on a busy connection, with bytes moving both ways at that moment. The operating system reports a
// reset once, to whichever call asks first: so of the writer and the reader, one sees the reset and the other
// may see a plain end. A client that wants the true cause has to remember the first error from either side
// (the engine's link does). Here: one of the two always sees the reset.
func TestResetOnABusyConnection(t *testing.T) {
	for i := 0; i < 100; i++ {
		p, c := start(t)
		writeErr := make(chan error, 1)
		go func() {
			buf := make([]byte, 4096)
			for {
				if _, err := c.Write(buf); err != nil {
					writeErr <- err
					return
				}
			}
		}()
		time.Sleep(2 * time.Millisecond)
		p.Reset()
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		buf := make([]byte, 65536)
		var readErr error
		for readErr == nil {
			_, readErr = c.Read(buf)
		}
		_ = c.Close()
		if w := <-writeErr; !isReset(readErr) && !isReset(w) && !isBrokenPipe(w) {
			t.Fatalf("round %d: neither side saw the reset: read %v, write %v", i, readErr, w)
		}
		p.Close()
	}
}
