package sftp_test

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	sshappsftp "sshapp/engine/internal/sftp"
)

// A box that answers a read with a data packet holding no bytes at all, and no end-of-file status with it.
// The protocol does not forbid it, and a box is not obliged to be sensible: this app's own rule is that
// nothing fails silently and that every cause is designed for, so what the bulk path does here is a fact
// worth having rather than a guess.
type zeroBox struct {
	reads atomic.Int64
}

func (z *zeroBox) serve(rw io.ReadWriteCloser) {
	for {
		kind, body, err := readOne(rw)
		if err != nil {
			return
		}
		switch kind {
		case 1: // INIT
			_ = writeOne(rw, 2, be32(3)) // VERSION 3
		case 3: // OPEN
			id := binary.BigEndian.Uint32(body)
			_ = writeOne(rw, 102, append(be32(id), str("h")...)) // HANDLE
		case 5: // READ
			z.reads.Add(1)
			id := binary.BigEndian.Uint32(body)
			_ = writeOne(rw, 103, append(be32(id), be32(0)...)) // DATA, zero bytes
		case 4: // CLOSE
			id := binary.BigEndian.Uint32(body)
			_ = writeOne(rw, 101, append(append(be32(id), be32(0)...), append(str(""), str("")...)...))
		default:
			if len(body) >= 4 {
				id := binary.BigEndian.Uint32(body)
				_ = writeOne(rw, 101, append(append(be32(id), be32(8)...), append(str("no"), str("")...)...))
			}
		}
	}
}

func be32(v uint32) []byte { return binary.BigEndian.AppendUint32(nil, v) }

func str(s string) []byte {
	return append(binary.BigEndian.AppendUint32(nil, uint32(len(s))), s...)
}

func readOne(r io.Reader) (byte, []byte, error) {
	var head [4]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(head[:])
	if n == 0 || n > 1<<20 {
		return 0, nil, errors.New("length")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return buf[0], buf[1:], nil
}

func writeOne(w io.Writer, kind byte, body []byte) error {
	out := binary.BigEndian.AppendUint32(nil, uint32(len(body)+1))
	out = append(out, kind)
	out = append(out, body...)
	_, err := w.Write(out)
	return err
}

// A box answering nothing, for ever, must not be able to hold a transfer open for ever. Before the blocks
// went out several at a time, the download loop stopped on an empty answer and the transfer failed on its
// hash, which is loud; the loop that replaced it asked again from the same place, which is the same ask
// with the same answer for ever. Measured before this was fixed: 316,479 reads in three seconds, no bytes
// taken, no end, nothing said. Now it is one round and then the fault, in words.
func TestAZeroLengthAnswerDoesNotSpinForEver(t *testing.T) {
	ours, theirs := net.Pipe()
	box := &zeroBox{}
	go box.serve(theirs)
	ctx, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	c, err := sshappsftp.Start(ctx, ours)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	f, err := c.Open(ctx, "/a/file")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	took := 0
	go func() {
		done <- f.ReadInOrder(ctx, 0, func(p []byte, at uint64) error {
			took += len(p)
			return nil
		})
	}()
	select {
	case err := <-done:
		if errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("the read never ended on its own: it was still asking when the three seconds ran out, after %d reads and %d bytes taken", box.reads.Load(), took)
		}
		t.Logf("ended on its own after %d reads: %v", box.reads.Load(), err)
	case <-time.After(4 * time.Second):
		t.Fatalf("the read did not even answer the context: %d reads", box.reads.Load())
	}
}
