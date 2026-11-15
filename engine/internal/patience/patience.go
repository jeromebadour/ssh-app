// Package patience sets how long the operating system keeps a TCP connection whose data goes unanswered.
//
// Why: the app never ends a link on a timer of its own. A silent link is shown as "no answer" and kept, so a
// shell and its job survive an internet drop of minutes. What ends a link that stays silent is the operating
// system's own limit, and this package sets that limit per connection, to ten minutes.
//
//	Linux:   TCP_USER_TIMEOUT, in milliseconds (tcp(7)).
//	Windows: TCP_MAXRT, in seconds (Microsoft: "IPPROTO_TCP socket options"; Windows Vista and later).
package patience

import (
	"errors"
	"net"
	"time"
)

// Default is how long a silent link is kept before the operating system gives up on it.
const Default = 10 * time.Minute

// ErrUnsupported is returned on a system this package has no setting for.
var ErrUnsupported = errors.New("patience: not supported on this system")

// Set asks the operating system to keep conn for d while its data goes unanswered.
func Set(conn *net.TCPConn, d time.Duration) error {
	if d < time.Second || d > 24*time.Hour {
		return errors.New("patience: must be between one second and one day")
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return err
	}
	var setErr error
	if err := raw.Control(func(fd uintptr) { setErr = set(fd, d) }); err != nil {
		return err
	}
	return setErr
}

// Get reads the setting back from the operating system.
func Get(conn *net.TCPConn) (time.Duration, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, err
	}
	var d time.Duration
	var getErr error
	if err := raw.Control(func(fd uintptr) { d, getErr = get(fd) }); err != nil {
		return 0, err
	}
	return d, getErr
}
