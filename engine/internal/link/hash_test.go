package link

import (
	"errors"
	"strings"
	"testing"
)

func TestANameIsQuotedSoABoxReadsItAsOneName(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"/srv/ledger/kit.tar.gz", `'/srv/ledger/kit.tar.gz'`},
		{"/srv/it's here/file", `'/srv/it'\''s here/file'`},
		{"/srv/$(rm -rf /)", `'/srv/$(rm -rf /)'`},
		{"/srv/`id`", "'/srv/`id`'"},
		{`/srv/a"b`, `'/srv/a"b'`},
		{"/srv/; rm -rf /", `'/srv/; rm -rf /'`},
		{"/srv/a|b&c", `'/srv/a|b&c'`},
		{"/srv/*", `'/srv/*'`},
		{"/srv/~root", `'/srv/~root'`},
		{"/srv/a\\b", `'/srv/a\b'`},
	} {
		got, err := quote(c.in)
		if err != nil {
			t.Fatalf("%q: %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("%q quoted as %s, not %s", c.in, got, c.want)
		}
	}
}

// A name that could be made to look like a line of the answer is never put in a command at all: a box could
// then seem to agree about a file it never saw.
func TestANameWithAControlCharacterIsNeverPutInACommand(t *testing.T) {
	for _, bad := range []string{
		"/srv/a\nb",
		"/srv/a\rb",
		"/srv/a\tb",
		"/srv/a\x00b",
		"/srv/a\x7fb",
		"/srv/new\nd41d8cd98f00b204e9800998ecf8427e  /srv/other",
		"",
	} {
		if _, err := quote(bad); !errors.Is(err, ErrNameNotSafe) {
			t.Fatalf("%q was quoted instead of refused", bad)
		}
	}
}

func TestTheHashIsTheLastLineOfTheRightShape(t *testing.T) {
	const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
	const md5 = "d41d8cd98f00b204e9800998ecf8427e"

	// A box's start-up files print whatever they like before the command runs.
	noisy := "Welcome to the box\nLast login: today\n" + sha + "  /srv/ledger/kit.tar.gz\n"
	got, err := hashIn(noisy, true)
	if err != nil || got != sha {
		t.Fatalf("got %q, %v", got, err)
	}

	// Carriage returns, which a terminal-less channel can still carry.
	if got, err := hashIn("noise\r\n"+sha+"  /x\r\n", true); err != nil || got != sha {
		t.Fatalf("got %q, %v", got, err)
	}

	// The escaped form GNU prints when the name held something it had to escape: a backslash at the very start.
	if got, err := hashIn("\\"+sha+"  /srv/odd\\nname\n", true); err != nil || got != sha {
		t.Fatalf("the escaped form gave %q, %v", got, err)
	}

	// The star form, which these tools print for a file read as binary.
	if got, err := hashIn(md5+" */x\n", false); err != nil || got != md5 {
		t.Fatalf("the star form gave %q, %v", got, err)
	}

	// The last of several is the answer, because what came before it is the box talking.
	two := md5 + "  /a\n" + "d41d8cd98f00b204e9800998ecf8427f  /b\n"
	if got, err := hashIn(two, false); err != nil || got != "d41d8cd98f00b204e9800998ecf8427f" {
		t.Fatalf("got %q, %v", got, err)
	}

	// A hash of the other length is not this answer: asking for sha256 and being given an md5 is no answer.
	if _, err := hashIn(md5+"  /x\n", true); !errors.Is(err, ErrNoHash) {
		t.Fatalf("an md5 was taken for a sha256: %v", err)
	}
	if _, err := hashIn(sha+"  /x\n", false); !errors.Is(err, ErrNoHash) {
		t.Fatalf("a sha256 was taken for an md5: %v", err)
	}
}

func TestWhatIsNotAnAnswerIsNotTakenForOne(t *testing.T) {
	for _, out := range []string{
		"",
		"sha256sum: /srv/nope: No such file or directory\n",
		"permission denied\n",
		"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a0  /x\n",  // 63 characters
		"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a088 /x\n", // 65, and one space
		"ZZ86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08  /x\n", // not hex
		strings.Repeat("noise\n", 500),
	} {
		if got, err := hashIn(out, true); !errors.Is(err, ErrNoHash) {
			t.Fatalf("%q gave %q, %v", out, got, err)
		}
	}
}

// Only the two hashes written down may be asked for: nothing else can be run on a box through this.
func TestOnlyTheTwoHashesWrittenDownMayBeAskedFor(t *testing.T) {
	l := &Link{}
	for _, bad := range []Hash{"cat", "rm", "", "sha256sum; id", "SHA256SUM"} {
		if _, err := l.Hash(nil, bad, "/x"); err == nil || strings.Contains(err.Error(), "did not answer") {
			t.Fatalf("%q was accepted as a hash to ask for: %v", bad, err)
		}
	}
}
