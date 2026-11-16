// Package sftp is Berth's own client for SFTP version 3, the file protocol that runs inside the SSH link.
//
// It is written here rather than taken from a library because of what this app promises: a listing streams to
// the window in pages and is never held whole, every request has a deadline and can be cancelled, and nothing
// a box sends can grow memory without bound. The libraries read a whole folder into one list and return it at
// the end, with no deadline and no way to stop (plan B4.1, and finding 12 of the plan's review).
//
// This file is the wire: how a packet is read and written, and how the protocol's values are taken out of one.
// Every read is bounded before anything is allocated, so a box that lies about a length cannot make this
// package reserve memory it does not have.
package sftp

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// The packet types this client sends and understands. SFTP version 3 (draft-ietf-secsh-filexfer-02).
const (
	fxpInit     = 1
	fxpVersion  = 2
	fxpOpen     = 3
	fxpClose    = 4
	fxpRead     = 5
	fxpWrite    = 6
	fxpLstat    = 7
	fxpFsetstat = 10
	fxpOpendir  = 11
	fxpReaddir  = 12
	fxpRemove   = 13
	fxpMkdir    = 14
	fxpRmdir    = 15
	fxpRealpath = 16
	fxpStat     = 17
	fxpRename   = 18
	fxpReadlink = 19

	fxpStatus        = 101
	fxpHandle        = 102
	fxpData          = 103
	fxpName          = 104
	fxpAttrs         = 105
	fxpExtended      = 200
	fxpExtendedReply = 201
)

// The status codes a box answers with. Each is a different thing to say to the person.
const (
	fxOK = iota
	fxEOF
	fxNoSuchFile
	fxPermissionDenied
	fxFailure
	fxBadMessage
	fxNoConnection
	fxConnectionLost
	fxOpUnsupported
)

// What this client will read at all. A packet larger than this is not a packet from a box doing its job: the
// largest thing in the protocol is one block of file data, and the client never asks for a block near this.
const maxPacket = 1 << 18 // 256 KiB

// Flags for opening a file.
const (
	openRead  = 0x00000001
	openWrite = 0x00000002
	openCreat = 0x00000008
	openTrunc = 0x00000010
	openExcl  = 0x00000020
)

// Which fields of an attributes block are present.
const (
	attrSize        = 0x00000001
	attrUIDGID      = 0x00000002
	attrPermissions = 0x00000004
	attrACModTime   = 0x00000008
	attrExtended    = 0x80000000
)

var (
	// ErrTooLong is a packet, or a value inside one, larger than this client will read.
	ErrTooLong = errors.New("sftp: the box sent more than this client will read")
	// ErrShort is a packet that ends in the middle of a value.
	ErrShort = errors.New("sftp: a packet from the box ends in the middle of a value")
	// ErrNotOurs is an answer that is not an answer to anything that was asked.
	ErrNotOurs = errors.New("sftp: an answer to a request that was never made")
)

// reader takes the protocol's values out of one packet's body. Every take is checked, and a take that cannot be
// made leaves the reader refusing every take after it, so one check at the end is enough.
type reader struct {
	b   []byte
	bad bool
}

func (r *reader) u32() uint32 {
	if r.bad || len(r.b) < 4 {
		r.bad = true
		return 0
	}
	v := binary.BigEndian.Uint32(r.b)
	r.b = r.b[4:]
	return v
}

func (r *reader) u64() uint64 {
	if r.bad || len(r.b) < 8 {
		r.bad = true
		return 0
	}
	v := binary.BigEndian.Uint64(r.b)
	r.b = r.b[8:]
	return v
}

func (r *reader) byte() byte {
	if r.bad || len(r.b) < 1 {
		r.bad = true
		return 0
	}
	v := r.b[0]
	r.b = r.b[1:]
	return v
}

// str is a length then that many bytes. The length is checked against what is left before anything is taken, so
// a length a box made up can never reserve memory.
func (r *reader) str() []byte {
	n := r.u32()
	if r.bad || uint64(n) > uint64(len(r.b)) {
		r.bad = true
		return nil
	}
	v := r.b[:n]
	r.b = r.b[n:]
	return v
}

func (r *reader) ok() bool { return !r.bad }

// writer builds a packet body.
type writer struct{ b []byte }

func (w *writer) u32(v uint32) { w.b = binary.BigEndian.AppendUint32(w.b, v) }
func (w *writer) u64(v uint64) { w.b = binary.BigEndian.AppendUint64(w.b, v) }
func (w *writer) byte(v byte)  { w.b = append(w.b, v) }
func (w *writer) str(v []byte) {
	w.u32(uint32(len(v)))
	w.b = append(w.b, v...)
}
func (w *writer) string(v string) { w.str([]byte(v)) }

// readPacket reads one packet: a length, a type, and that many bytes less one. Nothing is allocated until the
// length has been found to be one this client will read.
func readPacket(r io.Reader, into []byte) (kind byte, body []byte, err error) {
	var head [4]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(head[:])
	if n < 1 || n > maxPacket {
		return 0, nil, fmt.Errorf("%w: %d bytes", ErrTooLong, n)
	}
	if uint32(len(into)) < n {
		into = make([]byte, n)
	}
	buf := into[:n]
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return buf[0], buf[1:], nil
}

// writePacket writes one packet of this type with this body.
func writePacket(w io.Writer, kind byte, body []byte) error {
	var head [5]byte
	binary.BigEndian.PutUint32(head[:4], uint32(len(body)+1))
	head[4] = kind
	if _, err := w.Write(head[:]); err != nil {
		return err
	}
	if len(body) == 0 {
		return nil
	}
	_, err := w.Write(body)
	return err
}
