package link

// Asking a box for a file's hash, which is the one thing this app runs on a box for a transfer (plan B2.5,
// entry 3). It runs on a channel of its own with its own deadline, never in the terminal, so nothing a person
// is typing is touched and nothing of this is ever seen in their shell.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// The two hashes a box may be asked for, and nothing else. They are written out here rather than taken as a
// string from anywhere, so no caller can ask a box to run something of its own choosing.
type Hash string

const (
	SHA256 Hash = "sha256sum"
	MD5    Hash = "md5sum"
)

// How long a hash may take. A big file on a slow disk takes time, and this is the whole of it.
const HashDeadline = 10 * time.Minute

// What comes back at most. A hash line is under 300 bytes; a box that sends more than this is not answering.
const hashOutputMax = 64 << 10

var (
	// ErrNameNotSafe is a name that cannot be put in a command at all, so this box cannot be asked about it.
	// The transfer then says the file could not be checked on the box and offers to read it back instead.
	ErrNameNotSafe = errors.New("link: that name cannot be put in a command")
	// ErrNoHash is an answer with no hash line of the right shape in it.
	ErrNoHash = errors.New("link: the box did not answer with a hash")
)

// A hash line as the two tools print it: the hash, two spaces (or a space and a star), then the name. GNU puts
// a backslash at the very start when it had to escape something in the name.
var hashLine = regexp.MustCompile(`^\\?([0-9a-f]{32}|[0-9a-f]{64}) [ *](.*)$`)

// Hash asks the box for one file's hash. The file is named by its full path, quoted so that nothing in it can
// be read as anything but a name.
func (l *Link) Hash(ctx context.Context, which Hash, path string) (string, error) {
	if which != SHA256 && which != MD5 {
		return "", fmt.Errorf("link: %q is not a hash this app asks for", which)
	}
	quoted, err := quote(path)
	if err != nil {
		return "", err
	}
	out, err := l.run(ctx, string(which)+" -- "+quoted)
	if err != nil {
		return "", err
	}
	return hashIn(out, len(which) == len(SHA256))
}

// quote puts a path in single quotes so a box reads it as one name and nothing else. A single quote inside is
// closed, escaped and opened again, which is the only way out of single quotes in a shell.
//
// A name holding a newline or any other control character is refused outright rather than quoted: the answer
// comes back as lines, and a name that can be made to look like a line of the answer is a name that can make a
// box seem to agree about a file it never saw.
func quote(path string) (string, error) {
	if path == "" {
		return "", ErrNameNotSafe
	}
	for _, r := range path {
		if r < 0x20 || r == 0x7f {
			return "", ErrNameNotSafe
		}
	}
	return "'" + strings.ReplaceAll(path, "'", `'\''`) + "'", nil
}

// hashIn finds the hash in what the box printed. A box's start-up files print whatever they like before a
// command runs, so the answer is the last line of the right shape, not the first and not the whole output.
func hashIn(out string, wantSHA256 bool) (string, error) {
	want := 32
	if wantSHA256 {
		want = 64
	}
	for _, line := range reverse(strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n")) {
		m := hashLine.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m != nil && len(m[1]) == want {
			return m[1], nil
		}
	}
	return "", ErrNoHash
}

func reverse(in []string) []string {
	out := make([]string, 0, len(in))
	for i := len(in) - 1; i >= 0; i-- {
		out = append(out, in[i])
	}
	return out
}

// run opens a channel of its own, runs one command on it, and gives back what it printed. Nothing of this
// touches the terminal, and the channel is closed whatever happens.
func (l *Link) run(ctx context.Context, cmd string) (string, error) {
	ch, reqs, err := l.conn.OpenChannel("session", nil)
	if err != nil {
		return "", err
	}
	go ssh.DiscardRequests(reqs)
	defer func() { _ = ch.Close() }()

	if ok, err := ch.SendRequest("exec", true, ssh.Marshal(struct{ Command string }{cmd})); err != nil || !ok {
		return "", refusal("a hash", err)
	}

	type done struct {
		out string
		err error
	}
	finished := make(chan done, 1)
	go func() {
		// Only what the command printed is read, and only so much of it. What it printed on the other stream
		// is read and dropped, so the box is never blocked writing to a reader nobody is taking from.
		go func() { _, _ = io.Copy(io.Discard, io.LimitReader(ch.Stderr(), hashOutputMax)) }()
		b, err := io.ReadAll(io.LimitReader(ch, hashOutputMax))
		finished <- done{string(b), err}
	}()

	timer := time.NewTimer(HashDeadline)
	defer timer.Stop()
	select {
	case d := <-finished:
		if d.err != nil && !errors.Is(d.err, io.EOF) {
			return "", d.err
		}
		return d.out, nil
	case <-ctx.Done():
		return "", ctx.Err()
	case <-timer.C:
		return "", fmt.Errorf("link: the box did not answer with a hash within %s", HashDeadline)
	}
}
