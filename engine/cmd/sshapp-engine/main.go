// Command sshapp-engine is a tab's background process.
//
// Aimed at a box, it opens the one SSH link to it and the one shell on it (real.go) and carries both to main
// as frames. Aimed as a stub, it echoes typed bytes back and opens nothing: that is what the app's own
// self-test runs, so the processes, the routing and the watchdogs are proven with no box at all.
//
// Aimed with the role "identify" (identify.go), it asks one box who it is, for the first-connection check, and
// nothing else: it holds no key, signs in nowhere and ends when it has the answer.
//
// Rules it keeps either way:
//   - It is aimed once: the first frame must be Aim, and there is no message to change it.
//   - It ends when its parent is gone (standard input closes), and never because the parent is silent.
//   - A malformed frame ends it, after one Fatal frame saying why.
package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"sync"
	"time"

	"sshapp/engine/internal/frame"
)

const (
	exitOK       = 0
	exitNoAim    = 2
	exitBadFrame = 3
	exitWrite    = 4
	exitTooLarge = 5 // a frame this program tried to send was over the protocol's limit: a fault of ours

	aimWait = 10 * time.Second
)

type aim struct {
	V     int      `json:"v"`
	Role  string   `json:"role"` // "keys" for the key process, "identify" for a first-connection check, "firstvisit" for decision O2's one sign-in; otherwise a tab's engine
	File  string   `json:"file"` // the key process: where the list is
	Cost  *costAim `json:"cost"` // the key process: the cost a new list is sealed with, when it was tuned
	Tab   string   `json:"tab"`
	Stub  bool     `json:"stub"`  // the skeleton's echo, for the app's own self-test: no box, no network
	Box   boxAim   `json:"box"`   // not a stub: the one box
	Shell shellAim `json:"shell"` // and how its shell starts
	// The first visit only (decision O2): the password a person has just typed, and the one command it is for.
	// Both live only as long as this process, which is a few seconds, and neither is ever written down here.
	Password string `json:"password"`
	Command  string `json:"command"`
}

type out struct {
	mu sync.Mutex
	w  io.Writer
}

func (o *out) send(typ byte, body []byte) {
	buf, err := frame.Append(nil, typ, body)
	if err != nil {
		// A frame this program cannot send is a fault of this program, and the other end is waiting for an
		// answer that will never come. It is said on the one frame that is always small enough, and then this
		// program ends: a silent drop would leave the window waiting for ever with nothing to show.
		said, _ := frame.Append(nil, frame.TypeFatal, []byte(`{"error":"a frame of `+strconv.Itoa(len(body))+` bytes could not be sent"}`))
		o.mu.Lock()
		_, _ = o.w.Write(said)
		o.mu.Unlock()
		os.Exit(exitTooLarge)
	}
	o.mu.Lock()
	_, err = o.w.Write(buf)
	o.mu.Unlock()
	if err != nil {
		os.Exit(exitWrite) // the parent's end of the pipe is gone
	}
}

func (o *out) fatal(code int, why string) {
	body, _ := json.Marshal(map[string]string{"error": why})
	o.send(frame.TypeFatal, body)
	os.Exit(code)
}

func main() {
	o := &out{w: os.Stdout}

	// The first frame must arrive, and must be Aim. A parent that never aims us is a fault, not a wait.
	first := make(chan frame.Frame, 1)
	firstErr := make(chan error, 1)
	go func() {
		f, err := frame.Read(os.Stdin)
		if err != nil {
			firstErr <- err
			return
		}
		first <- f
	}()

	var target aim
	select {
	case f := <-first:
		if f.Type != frame.TypeAim {
			o.fatal(exitNoAim, "the first frame was not Aim")
		}
		if err := json.Unmarshal(f.Body, &target); err != nil {
			o.fatal(exitNoAim, "Aim could not be read")
		}
		// The roles are written out here and nowhere else, so a run of this program is one of exactly four
		// things and can never be talked into being another. Read after the Aim is parsed and not before it,
		// or every role would pass: the field is still empty until the line above has run.
		known := target.Role == "" || target.Role == "keys" || target.Role == "identify" || target.Role == "firstvisit"
		if target.V != 1 || !known || (target.Tab == "" && target.Role == "") {
			o.fatal(exitNoAim, "Aim could not be read")
		}
	case err := <-firstErr:
		if errors.Is(err, io.EOF) {
			os.Exit(exitOK)
		}
		o.fatal(exitBadFrame, "bad first frame: "+err.Error())
	case <-time.After(aimWait):
		o.fatal(exitNoAim, "no Aim arrived")
	}

	if target.Role == "keys" {
		os.Exit(runKeys(o, target))
	}
	if target.Role == "identify" {
		os.Exit(runIdentify(o, target.Box.Addr))
	}
	if target.Role == "firstvisit" {
		os.Exit(runFirstVisit(o, target))
	}

	hello, _ := json.Marshal(map[string]any{"v": 1, "role": "engine", "stub": target.Stub, "tab": target.Tab})
	o.send(frame.TypeHello, hello)

	if !target.Stub {
		frames := make(chan frame.Frame, 64)
		go func() {
			defer close(frames)
			for {
				f, err := frame.Read(os.Stdin)
				if err != nil {
					if errors.Is(err, io.EOF) {
						return // the parent closed our input: it is gone, or it closed this tab
					}
					o.fatal(exitBadFrame, "bad frame: "+err.Error())
				}
				frames <- f
			}
		}()
		os.Exit(runReal(o, frames, target.Box, target.Shell))
	}

	for {
		f, err := frame.Read(os.Stdin)
		if err != nil {
			if errors.Is(err, io.EOF) {
				os.Exit(exitOK) // the parent closed our input: it is gone, or it closed this tab
			}
			o.fatal(exitBadFrame, "bad frame: "+err.Error())
		}
		switch f.Type {
		case frame.TypePing:
			o.send(frame.TypePong, f.Body)
		case frame.TypeInput:
			o.send(frame.TypeOutput, f.Body) // skeleton only: echo
		case frame.TypeAim:
			o.fatal(exitBadFrame, "an engine is aimed once")
		default:
			o.fatal(exitBadFrame, "unknown frame type")
		}
	}
}
