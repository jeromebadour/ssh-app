package main

// What the file browser will not delete, whatever is asked of it (plan B4.4).
//
// This is judged on the path as the box itself resolves it, never on what was typed: a link, a folder renamed
// under us, or a name holding ".." would otherwise walk straight through the list. The engine resolves first
// and asks this second.
//
// The list is of places where a delete is not a mistake to be undone but a box to be rebuilt. It is deliberately
// blunt: a person who really means to remove something under /etc has a terminal in the same window, where the
// command says what it is and the shell is theirs. The browser is the place where a tired hand should not be
// able to do that.

import "strings"

// The folders this app will not delete from, and everything inside them. Their own parents are refused too, so
// a delete of "/" or "/usr" is refused by the same rule that refuses "/usr/bin/ls".
var neverDelete = []string{
	"/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run", "/sbin",
	"/sys", "/usr", "/var/lib",
}

// refuseReason says why a path may not be deleted, or an empty string when it may be.
func refuseReason(p string) string {
	clean := tidy(p)
	if clean == "" {
		return "that is not a path on the box"
	}
	if clean == "/" {
		return "that is the top of the box"
	}
	// Directly under the top: /home, /opt, /srv and the rest are where a box keeps everything it is for, and
	// removing one of them is not something this browser does.
	if strings.Count(clean, "/") == 1 {
		return "that is a folder at the top of the box"
	}
	for _, no := range neverDelete {
		if clean == no || strings.HasPrefix(clean, no+"/") {
			return "that is part of the system (" + no + ")"
		}
	}
	// The keys that let this app in, and everything beside them. Deleting these locks the app out of the box.
	if clean == "/root/.ssh" || strings.HasPrefix(clean, "/root/.ssh/") || strings.HasSuffix(clean, "/.ssh") || strings.Contains(clean, "/.ssh/") {
		return "that is where the box keeps the keys that let you in"
	}
	// The app's own trash: it is emptied through its own door, not deleted into itself.
	if clean == trashName || strings.HasSuffix(clean, "/"+trashName) || strings.Contains(clean, "/"+trashName+"/") {
		return "that is Berth's own trash, which is emptied rather than deleted"
	}
	return ""
}

// tidy makes a path the one shape everything here is judged on: one leading slash, no "." or ".." left in it,
// no repeated or trailing slashes. A path that climbs above the top is not a path at all.
func tidy(p string) string {
	if !strings.HasPrefix(p, "/") {
		return ""
	}
	out := make([]string, 0, 8)
	for _, bit := range strings.Split(p, "/") {
		switch bit {
		case "", ".":
		case "..":
			if len(out) == 0 {
				return ""
			}
			out = out[:len(out)-1]
		default:
			out = append(out, bit)
		}
	}
	return "/" + strings.Join(out, "/")
}
