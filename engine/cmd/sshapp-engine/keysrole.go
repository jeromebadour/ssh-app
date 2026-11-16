package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"sshapp/engine/internal/frame"
	"sshapp/engine/internal/keys"
	"sshapp/engine/internal/vault"
)

// The key process (plan B1, B2.4): the same program, aimed with the role "keys". After the password it holds
// the open list and its keys in memory, signs sign-in requests, and saves and backs up the list. It opens no
// network connection, is spoken to by main only, and sees nothing a box sent except the bytes of a sign-in
// request, which it checks field by field. It ends when main is gone, wiping what it held.

const (
	minPasswordChars = 12
	firstWait        = time.Second
	longestWait      = 30 * time.Second

	pwCreate  = 1
	pwUnlock  = 2
	pwChange  = 3
	pwRestore = 4 // body: 4-byte length, a backup file's path, then that backup's password
)

type costAim struct {
	Time      uint32 `json:"time"`
	MemoryKiB uint32 `json:"memoryKiB"`
	Threads   uint8  `json:"threads"`
}

type keyProc struct {
	o    *out
	path string
	cost vault.Params
	open *keys.Unlocked

	wait      time.Duration // after a wrong password: how long the next try must wait; doubles
	notBefore time.Time

	// How long main has gone without a word. Main beats once a second; this process is the one place that
	// can see main stop, because a stalled main cannot report itself (plan B1, B8 rule 5). The reader
	// goroutine writes these and the worker goroutine reads them, so they are atomic.
	lastBeat atomic.Int64 // when the last beat came, in nanoseconds
	stalls   atomic.Int64 // how many times main went quiet for longer than mainQuietAfter
	longest  atomic.Int64 // the longest of those silences, in nanoseconds
}

// How long main may go without a word before this process counts it as a stall. Main beats every second, so
// this is five beats missed. The same five seconds main allows this process (keyproc.ts).
const mainQuietAfter = 5 * time.Second

// beat is called for every word from main: a stall is the gap since the last one.
func (k *keyProc) beat(now time.Time) {
	was := k.lastBeat.Swap(now.UnixNano())
	if was == 0 {
		return // the first word: there is no gap before it
	}
	if gap := now.Sub(time.Unix(0, was)); gap > mainQuietAfter {
		k.stalls.Add(1)
		for {
			longest := k.longest.Load()
			if int64(gap) <= longest || k.longest.CompareAndSwap(longest, int64(gap)) {
				break
			}
		}
	}
}

type keyRequest struct {
	ID        uint64          `json:"id"`
	Op        string          `json:"op"`
	Name      string          `json:"name"`
	Box       string          `json:"box"`
	User      string          `json:"user"`
	Key       string          `json:"key"`
	Algorithm string          `json:"algorithm"`
	Data      string          `json:"data"`
	Dir       string          `json:"dir"`
	Public    json.RawMessage `json:"public"`
}

func runKeys(o *out, target aim) int {
	if !filepath.IsAbs(target.File) {
		o.fatal(exitNoAim, "the key process was given no place for the list")
	}
	k := &keyProc{o: o, path: target.File, cost: vault.Default}
	if c := target.Cost; c != nil {
		k.cost = vault.Params{Time: c.Time, MemoryKiB: c.MemoryKiB, Threads: c.Threads}
	}
	hello, _ := json.Marshal(map[string]any{"v": 1, "role": "keys"})
	o.send(frame.TypeHello, hello)

	// The heartbeat is answered by the reader itself, so that the second a password takes is not a silence.
	work := make(chan frame.Frame, 16)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for f := range work {
			k.handle(f)
		}
	}()
	for {
		f, err := frame.Read(os.Stdin)
		if err != nil {
			close(work)
			wg.Wait()
			if k.open != nil {
				k.open.Close() // main is gone: wipe what was held
			}
			if errors.Is(err, io.EOF) {
				return exitOK
			}
			o.fatal(exitBadFrame, "bad frame: "+err.Error())
		}
		switch f.Type {
		case frame.TypePing:
			k.beat(time.Now())
			o.send(frame.TypePong, f.Body)
		case frame.TypeKeyRequest, frame.TypePassword:
			k.beat(time.Now())
			work <- f
		default:
			o.fatal(exitBadFrame, "not a frame for the key process")
		}
	}
}

func (k *keyProc) reply(id uint64, v map[string]any) {
	v["id"] = id
	if _, failed := v["error"]; !failed {
		v["ok"] = true
	} else {
		v["ok"] = false
	}
	body, _ := json.Marshal(v)
	k.o.send(frame.TypeKeyReply, body)
}

func (k *keyProc) fail(id uint64, code string, err error) {
	v := map[string]any{"error": code}
	if err != nil {
		v["detail"] = err.Error()
	}
	k.reply(id, v)
}

func (k *keyProc) handle(f frame.Frame) {
	if f.Type == frame.TypePassword {
		k.password(f.Body)
		clear(f.Body)
		return
	}
	var q keyRequest
	if json.Unmarshal(f.Body, &q) != nil || q.Op == "" {
		k.o.fatal(exitBadFrame, "a request to the key process could not be read")
	}
	if q.Op == "status" {
		exists, err := keys.Exists(k.path)
		if err != nil {
			k.fail(q.ID, "cannot-read", err)
			return
		}
		v := map[string]any{"exists": exists, "unlocked": k.open != nil, "hasPrevious": keys.HasPrevious(k.path), "mainStalls": k.stalls.Load(), "mainLongestStallMs": k.longest.Load() / int64(time.Millisecond)}
		if left := time.Until(k.notBefore); left > 0 {
			v["retryAfterMs"] = left.Milliseconds()
		}
		k.reply(q.ID, v)
		return
	}
	if k.open == nil {
		k.fail(q.ID, "locked", nil)
		return
	}
	u := k.open
	switch q.Op {
	case "keys":
		k.reply(q.ID, map[string]any{"keys": infos(u)})
	case "sign":
		data, err := base64.StdEncoding.DecodeString(q.Data)
		if err != nil {
			k.fail(q.ID, "bad-request", err)
			return
		}
		sig, err := u.Sign(q.Key, q.Box, q.Algorithm, data)
		if err != nil {
			k.fail(q.ID, signCode(err), err)
			return
		}
		k.reply(q.ID, map[string]any{"signature": base64.StdEncoding.EncodeToString(sig)})
	case "newKey":
		info, err := u.NewKey(q.Name, q.Box, q.User, time.Now())
		if err != nil {
			k.fail(q.ID, "refused", err)
			return
		}
		k.saved(q.ID, map[string]any{"publicKey": info.PublicKey}, func() { _ = u.Delete(q.Name) })
	case "rebind":
		if err := u.Rebind(q.Key, q.Box, q.User); err != nil {
			k.fail(q.ID, "refused", err)
			return
		}
		k.saved(q.ID, map[string]any{}, nil)
	case "deleteKey":
		if err := u.Delete(q.Key); err != nil {
			k.fail(q.ID, "refused", err)
			return
		}
		k.saved(q.ID, map[string]any{}, nil)
	case "setPublic":
		before := append(json.RawMessage(nil), u.Public()...)
		if err := u.SetPublic(q.Public); err != nil {
			k.fail(q.ID, "refused", err)
			return
		}
		k.saved(q.ID, map[string]any{}, func() { _ = u.SetPublic(before) })
	case "setBackupDir":
		if q.Dir != "" && !filepath.IsAbs(q.Dir) {
			k.fail(q.ID, "refused", errors.New("not a full path"))
			return
		}
		before := u.BackupDir()
		u.SetBackupDir(q.Dir)
		k.saved(q.ID, map[string]any{}, func() { u.SetBackupDir(before) })
	default:
		k.o.fatal(exitBadFrame, "the key process was asked for something it does not do")
	}
}

func signCode(err error) string {
	switch {
	case errors.Is(err, keys.ErrNoSuchKey):
		return "no-such-key"
	case errors.Is(err, keys.ErrNotThisBox):
		return "not-this-box"
	case errors.Is(err, keys.ErrBadRequest):
		return "not-a-sign-in"
	}
	return "refused"
}

func infos(u *keys.Unlocked) []map[string]any {
	out := []map[string]any{}
	for _, i := range u.Keys() {
		out = append(out, map[string]any{"name": i.Name, "box": i.Box, "user": i.User, "publicKey": i.PublicKey, "created": i.Created.Format(time.RFC3339)})
	}
	return out
}

// saved writes the list after a change and answers. If the list cannot be saved, the change is taken back in
// memory too (undo), so what is in memory is never ahead of what is on disk.
func (k *keyProc) saved(id uint64, v map[string]any, undo func()) {
	backupErr, err := k.open.Save(time.Now())
	if err != nil {
		if undo != nil {
			undo()
		}
		k.fail(id, "not-saved", err)
		return
	}
	k.backupWord(v, backupErr)
	k.reply(id, v)
}

func (k *keyProc) backupWord(v map[string]any, backupErr error) {
	v["savedAt"] = k.open.SavedAt.UTC().Format(time.RFC3339)
	switch {
	case k.open.BackupDir() == "":
		v["backup"] = "none"
	case backupErr != nil:
		v["backup"], v["backupDetail"] = "failed", backupErr.Error()
	default:
		v["backup"] = "written"
	}
}

func (k *keyProc) password(body []byte) {
	if len(body) < 9 {
		k.o.fatal(exitBadFrame, "a Password frame is too short")
	}
	id, op, rest := binary.BigEndian.Uint64(body), body[8], body[9:]
	now := time.Now()
	if left := k.notBefore.Sub(now); left > 0 && (op == pwUnlock || op == pwRestore) {
		k.reply(id, map[string]any{"error": "wait", "retryAfterMs": left.Milliseconds()})
		return
	}
	switch op {
	case pwCreate:
		if k.open != nil {
			k.fail(id, "already-unlocked", nil)
			return
		}
		if utf8.RuneCount(rest) < minPasswordChars || !utf8.Valid(rest) {
			k.fail(id, "password-too-short", nil)
			return
		}
		u, err := keys.Create(k.path, rest, k.cost, now)
		if err != nil {
			k.fail(id, map[bool]string{true: "exists", false: "not-saved"}[errors.Is(err, keys.ErrListExists)], err)
			return
		}
		k.open = u
		k.unlocked(id)
	case pwUnlock:
		if k.open != nil {
			k.fail(id, "already-unlocked", nil)
			return
		}
		k.tryOpen(id, k.path, rest, false)
	case pwRestore:
		if k.open != nil || len(rest) < 4 || int(binary.BigEndian.Uint32(rest)) > len(rest)-4 {
			k.fail(id, "refused", nil)
			return
		}
		n := int(binary.BigEndian.Uint32(rest))
		from := string(rest[4 : 4+n])
		if !filepath.IsAbs(from) {
			k.fail(id, "refused", errors.New("not a full path"))
			return
		}
		k.tryOpen(id, from, rest[4+n:], true)
	case pwChange:
		if k.open == nil {
			k.fail(id, "locked", nil)
			return
		}
		if utf8.RuneCount(rest) < minPasswordChars || !utf8.Valid(rest) {
			k.fail(id, "password-too-short", nil)
			return
		}
		backupErr, err := k.open.ChangePassword(rest, k.cost, now)
		if err != nil {
			k.fail(id, "not-saved", err)
			return
		}
		v := map[string]any{}
		k.backupWord(v, backupErr)
		k.reply(id, v)
	default:
		k.o.fatal(exitBadFrame, "a Password frame of an unknown kind")
	}
}

// tryOpen opens the list (or, restoring, a backup that then becomes the list). A wrong password is said
// plainly and makes the next try wait: one second, doubling to thirty.
func (k *keyProc) tryOpen(id uint64, from string, password []byte, restore bool) {
	u, err := keys.Unlock(from, password)
	if err != nil {
		v := map[string]any{"hasPrevious": keys.HasPrevious(k.path)}
		switch {
		case errors.Is(err, vault.ErrPassword):
			if k.wait == 0 {
				k.wait = firstWait
			} else if k.wait *= 2; k.wait > longestWait {
				k.wait = longestWait
			}
			k.notBefore = time.Now().Add(k.wait)
			v["error"], v["retryAfterMs"] = "wrong-password", k.wait.Milliseconds()
		case errors.Is(err, keys.ErrNoList):
			v["error"] = "no-list"
		case errors.Is(err, vault.ErrDamaged), errors.Is(err, keys.ErrBadList):
			v["error"] = "damaged"
		case errors.Is(err, vault.ErrNewer):
			v["error"] = "newer-version"
		case errors.Is(err, vault.ErrNotAList):
			v["error"] = "not-a-list"
		case errors.Is(err, vault.ErrCost):
			v["error"] = "cost-out-of-range"
		default:
			v["error"], v["detail"] = "cannot-read", err.Error()
		}
		k.reply(id, v)
		return
	}
	k.wait, k.notBefore = 0, time.Time{}
	if restore {
		opened := u.SavedAt
		if _, err := u.SaveAs(k.path, time.Now()); err != nil {
			u.Close()
			k.fail(id, "not-saved", err)
			return
		}
		u.SavedAt = opened // what is shown at unlock: when the copy that was restored had been saved
	}
	k.open = u
	k.unlocked(id)
}

func (k *keyProc) unlocked(id uint64) {
	u := k.open
	k.reply(id, map[string]any{"savedAt": u.SavedAt.UTC().Format(time.RFC3339), "public": u.Public(), "backupDir": u.BackupDir(), "keys": infos(u)})
}
