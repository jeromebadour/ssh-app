//go:build !linux && !windows

package patience

import "time"

func set(uintptr, time.Duration) error { return ErrUnsupported }

func get(uintptr) (time.Duration, error) { return 0, ErrUnsupported }
