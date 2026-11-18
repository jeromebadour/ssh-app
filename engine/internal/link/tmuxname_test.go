package link

import "testing"

func TestStartInTmux(t *testing.T) {
	for _, c := range []struct{ folder, tmux, want string }{
		{"/srv/app", "work", `exec tmux -L berth -f /dev/null set -g mouse on \; new-session -A -s 'work' -c '/srv/app'`},
		{"", "work", `exec tmux -L berth -f /dev/null set -g mouse on \; new-session -A -s 'work'`},
		{"/srv/it's", "a_b-1", `exec tmux -L berth -f /dev/null set -g mouse on \; new-session -A -s 'a_b-1' -c '/srv/it'\''s'`},
	} {
		got, err := StartIn(c.folder, c.tmux)
		if err != nil || got != c.want {
			t.Fatalf("StartIn(%q,%q) = %q, %v; want %q", c.folder, c.tmux, got, err, c.want)
		}
	}
	for _, bad := range []string{"a b", "a.b", "a:b", "a;reboot", "../x", "a'b", string(make([]byte, 33))} {
		if _, err := StartIn("/srv", bad); err == nil {
			t.Fatalf("StartIn took a name it must refuse: %q", bad)
		}
	}
}
