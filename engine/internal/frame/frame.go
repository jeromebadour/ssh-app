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
	TypeResize byte = 0x12 // main to engine: the terminal's new size
	TypeAck    byte = 0x13 // main to engine: how many Output bytes the tab has taken in all (8 bytes, big endian)

	TypeState       byte = 0x20 // engine to main: where the link is, and when it ends, exactly why
	TypePulse       byte = 0x21 // engine to main: the keepalive's last word (a round trip, or silence since when)
	TypeSignRequest byte = 0x22 // engine to main, for the key process: sign this for the box's sign-in
	TypeSignReply   byte = 0x23 // main to engine: the signature, or why there is none
	TypeBanner      byte = 0x24 // engine to main: the box's sign-in text, raw. Text from a box: terminal only
	TypeExit        byte = 0x25 // engine to main: the shell ended, with its status if the box gave one
	TypeNotice      byte = 0x26 // engine to main: something the tab must say (the box is waiting on the window, typed bytes were dropped)

	TypeFatal byte = 0x7f // engine to main, sent once before the engine exits on a fault
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
