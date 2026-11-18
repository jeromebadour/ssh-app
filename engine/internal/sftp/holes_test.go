package sftp_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	sshappsftp "sshapp/engine/internal/sftp"
)

// A box that holds a file of its own and answers short, once, in the middle of it: the one thing the
// protocol allows that a reader asking for many blocks at a time can turn into a hole.
type shortBox struct {
	file     []byte
	shortAt  uint64
	shortN   int
	mu       sync.Mutex
	didShort bool
}

func (z *shortBox) serve(rw io.ReadWriteCloser) {
	for {
		kind, body, err := readOne(rw)
		if err != nil {
			return
		}
		switch kind {
		case 1:
			_ = writeOne(rw, 2, be32(3))
		case 3:
			_ = writeOne(rw, 102, append(be32(binary.BigEndian.Uint32(body)), str("h")...))
		case 5:
			id := binary.BigEndian.Uint32(body)
			r := body[4:]
			hl := binary.BigEndian.Uint32(r) // the handle's length, then the handle itself
			at := binary.BigEndian.Uint64(r[4+hl:])
			want := int(binary.BigEndian.Uint32(r[4+hl+8:]))
			if at >= uint64(len(z.file)) {
				_ = writeOne(rw, 101, append(append(be32(id), be32(1)...), append(str("end"), str("")...)...))
				continue
			}
			end := int(at) + want
			if end > len(z.file) {
				end = len(z.file)
			}
			part := z.file[at:end]
			z.mu.Lock()
			if at == z.shortAt && !z.didShort {
				z.didShort = true
				if z.shortN < len(part) {
					part = part[:z.shortN]
				}
			}
			z.mu.Unlock()
			out := append(be32(id), binary.BigEndian.AppendUint32(nil, uint32(len(part)))...)
			out = append(out, part...)
			_ = writeOne(rw, 103, out)
		case 4:
			_ = writeOne(rw, 101, append(append(be32(binary.BigEndian.Uint32(body)), be32(0)...), append(str(""), str("")...)...))
		default:
			if len(body) >= 4 {
				_ = writeOne(rw, 101, append(append(be32(binary.BigEndian.Uint32(body)), be32(8)...), append(str("no"), str("")...)...))
			}
		}
	}
}

// Reading many blocks at a time must hand every byte of the file to the hash once, in order, even when the
// box answers short in the middle: that is where a hole would be, and a hole is a file called whole that is
// not. The file is three rounds and a bit, and the short answer lands inside the first round.
func TestNoHoleWhenABoxAnswersShortMidFile(t *testing.T) {
	const block = 32 << 10
	file := make([]byte, block*70+1234)
	for i := range file {
		file[i] = byte(i*7 + i/251)
	}
	for _, shortAt := range []uint64{block * 3, block * 31, block * 64} {
		for _, shortN := range []int{1, 7, block / 2, block - 1} {
			ours, theirs := net.Pipe()
			box := &shortBox{file: file, shortAt: shortAt, shortN: shortN}
			go box.serve(theirs)
			ctx, stop := context.WithTimeout(context.Background(), 20*time.Second)
			c, err := sshappsftp.Start(ctx, ours)
			if err != nil {
				t.Fatal(err)
			}
			f, err := c.Open(ctx, "/a/file")
			if err != nil {
				t.Fatal(err)
			}
			var got bytes.Buffer
			var next uint64
			err = f.ReadInOrder(ctx, 0, func(p []byte, at uint64) error {
				if at != next {
					t.Fatalf("short at %d by %d: a block arrived for %d where %d was due", shortAt, shortN, at, next)
				}
				next += uint64(len(p))
				got.Write(p)
				return nil
			})
			if err != nil {
				t.Fatalf("short at %d by %d: %v", shortAt, shortN, err)
			}
			if !bytes.Equal(got.Bytes(), file) {
				t.Fatalf("short at %d by %d: took %d bytes of %d, and they are %v the file", shortAt, shortN, got.Len(), len(file), map[bool]string{true: "exactly", false: "NOT"}[bytes.Equal(got.Bytes(), file)])
			}
			c.Close()
			stop()
		}
	}
}
