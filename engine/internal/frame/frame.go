// Package frame is the one message format spoken between the app's processes.
//
// A frame is: a 4-byte big-endian length, then that many bytes: one type byte and the body.
// The length counts the type byte, so it is at least 1 and at most MaxPayload.
// The same format and the same test vectors (protocol/vectors.json) are used by the TypeScript side.
package frame

import (
	"encoding/binary"
	"errors"
	"io"
)

// MaxPayload is the largest type-plus-body size a frame may carry: 1 MiB.
const MaxPayload = 1 << 20

// Frame types. Control frames carry small JSON bodies; Input and Output carry raw bytes.
const (
	TypeAim    byte = 0x01 // main to engine, first frame only: what this engine is for
	TypeHello  byte = 0x02 // engine to main, the answer to Aim
	TypePing   byte = 0x03 // main to engine, heartbeat
	TypePong   byte = 0x04 // engine to main, the same body back
	TypeInput  byte = 0x10 // main to engine: bytes typed in the tab
	TypeOutput byte = 0x11 // engine to main: bytes for the tab's terminal
	TypeFatal  byte = 0x7f // engine to main, sent once before the engine exits on a fault
)

var (
	ErrEmpty    = errors.New("frame: length is zero")
	ErrTooLarge = errors.New("frame: length is over the limit")
)

// Frame is one decoded message. Body is owned by the caller.
type Frame struct {
	Type byte
	Body []byte
}

// Append adds the encoded frame to dst and returns the result.
func Append(dst []byte, typ byte, body []byte) ([]byte, error) {
	if len(body)+1 > MaxPayload {
		return dst, ErrTooLarge
	}
	var head [5]byte
	binary.BigEndian.PutUint32(head[:4], uint32(len(body)+1))
	head[4] = typ
	dst = append(dst, head[:]...)
	return append(dst, body...), nil
}

// Read reads exactly one frame. It never allocates more than MaxPayload for a frame,
// whatever length the peer claims. io.EOF is returned only on a clean end between frames.
func Read(r io.Reader) (Frame, error) {
	var head [4]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return Frame{}, err // io.EOF if nothing was read, io.ErrUnexpectedEOF if cut short
	}
	n := binary.BigEndian.Uint32(head[:])
	if n == 0 {
		return Frame{}, ErrEmpty
	}
	if n > MaxPayload {
		return Frame{}, ErrTooLarge
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		if err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return Frame{}, err
	}
	return Frame{Type: buf[0], Body: buf[1:]}, nil
}
