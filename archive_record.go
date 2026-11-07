package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	archiveRoot            = "/mnt/sda"
	archivePollInterval    = 2 * time.Second
	archiveCleanupInterval = time.Minute
	archiveOrphanPartAge   = 5 * time.Minute
)

type archiveChannel struct {
	ID     uint32 `gorm:"column:id"`
	Enable uint8  `gorm:"column:enable"`
	Record int64  `gorm:"column:record"`
}

type archiveState struct {
	minute    int64
	file      *os.File
	partPath  string
	finalPath string
	seen      map[string]string
}

func archiveWorker() {
	states := make(map[uint32]*archiveState)
	ticker := time.NewTicker(archivePollInterval)
	defer ticker.Stop()
	defer func() {
		for id, s := range states {
			if err := closeArchiveMinute(s); err != nil {
				slog(fmt.Sprintf("Archive %d: %v", id, err), "error")
			}
		}
	}()
	lastCleanup := time.Time{}
	for {
		mounted, err := isArchiveMounted(archiveRoot)
		if err != nil || !mounted {
			for id, s := range states {
				if err := closeArchiveMinute(s); err != nil {
					slog(fmt.Sprintf("Archive %d: %v", id, err), "error")
				}
				delete(states, id)
			}
			slog(fmt.Sprintf("Archive: NAS unavailable at %s: %v", archiveRoot, err), "error")
			<-ticker.C
			continue
		}
		var channels []archiveChannel
		if err := db.Table("channels").Select("id, enable, record").Find(&channels).Error; err != nil {
			slog("Archive: channels query: "+err.Error(), "error")
			<-ticker.C
			continue
		}
		allowed := make(map[uint32]bool, len(channels))
		for _, ch := range channels {
			if ch.Enable != 1 || ch.Record <= 0 {
				continue
			}
			allowed[ch.ID] = true
			s := states[ch.ID]
			if s == nil {
				s = &archiveState{minute: -1, seen: make(map[string]string)}
				states[ch.ID] = s
			}
			if err := ingestHLS(ch.ID, s); err != nil {
				slog(fmt.Sprintf("Archive %d: %v", ch.ID, err), "error")
			}
		}
		for id, s := range states {
			if allowed[id] {
				continue
			}
			if err := closeArchiveMinute(s); err != nil {
				slog(fmt.Sprintf("Archive %d: %v", id, err), "error")
			}
			delete(states, id)
		}
		if time.Since(lastCleanup) >= archiveCleanupInterval {
			if err := cleanupRecordedChannels(channels, states); err != nil {
				slog("Archive cleanup: "+err.Error(), "error")
			}
			lastCleanup = time.Now()
		}
		<-ticker.C
	}
}

// Предполагается, что archiveRoot — самостоятельная точка монтирования.
func isArchiveMounted(mountPoint string) (bool, error) {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return false, err
	}
	want := filepath.Clean(mountPoint)
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		got := strings.ReplaceAll(f[4], `\040`, " ")
		if filepath.Clean(got) == want {
			return true, nil
		}
	}
	return false, nil
}

// Читаем только сегменты, уже опубликованные в HLS playlist.
func ingestHLS(id uint32, s *archiveState) error {
	dir := filepath.Join(hlsDirectory, strconv.FormatUint(uint64(id), 10))
	manifest, err := os.Open(filepath.Join(dir, "index.m3u8"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer manifest.Close()

	var names []string
	scanner := bufio.NewScanner(io.LimitReader(manifest, 1<<20))
	for scanner.Scan() {
		name := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(name, "segment_") || !strings.HasSuffix(name, ".ts") {
			continue
		}
		digits := strings.TrimSuffix(strings.TrimPrefix(name, "segment_"), ".ts")
		if digits == "" || len(digits) > 20 {
			continue
		}
		if _, err := strconv.ParseUint(digits, 10, 64); err != nil {
			continue
		}
		names = append(names, name)
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	active := make(map[string]bool, len(names))
	for _, name := range names {
		active[name] = true
		source := filepath.Join(dir, name)
		info, err := os.Lstat(source)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			continue
		}
		signature := fmt.Sprintf("%d:%d", info.Size(), info.ModTime().UnixNano())
		if s.seen[name] == signature {
			continue
		}
		minute := info.ModTime().Unix() / 60 * 60
		if err := appendArchiveSegment(id, s, minute, source); err != nil {
			return err
		}
		s.seen[name] = signature
	}
	for name := range s.seen {
		if !active[name] {
			delete(s.seen, name)
		}
	}
	// Публикуем последнюю минуту, даже если поток остановился
	// или в текущую минуту больше нет новых сегментов.
	if s.file != nil && time.Now().Unix() >= s.minute+70 {
		return closeArchiveMinute(s)
	}
	return nil
}

func appendArchiveSegment(id uint32, s *archiveState, minute int64, source string) error {
	if s.file != nil && s.minute != minute {
		if err := closeArchiveMinute(s); err != nil {
			return err
		}
	}
	if s.file == nil {
		dir := filepath.Join(archiveRoot, strconv.FormatUint(uint64(id), 10))
		if err := os.MkdirAll(dir, 0750); err != nil {
			return err
		}
		final := filepath.Join(dir, strconv.FormatInt(minute, 10)+".ts")
		part := final + ".part"
		// Если после перезапуска уже существует запись этой минуты,
		// возвращаем её в статус незавершённой, чтобы продолжить.
		if _, err := os.Stat(part); os.IsNotExist(err) {
			if _, err := os.Stat(final); err == nil {
				if err := os.Rename(final, part); err != nil {
					return err
				}
			}
		}
		out, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0640)
		if err != nil {
			return err
		}
		s.file, s.partPath, s.finalPath, s.minute = out, part, final, minute
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	before, err := s.file.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	if _, err := io.Copy(s.file, in); err != nil {
		_ = s.file.Truncate(before)
		return err
	}
	return nil
}

func closeArchiveMinute(s *archiveState) error {
	if s.file == nil {
		return nil
	}
	f := s.file
	s.file = nil
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(s.partPath, s.finalPath); err != nil {
		return err
	}
	s.minute = -1
	return nil
}

// Удаляет завершённые записи, вышедшие за срок хранения, и
// осиротевшие .ts.part, которые не используются активным архиватором.
func cleanupRecordedChannels(channels []archiveChannel, states map[uint32]*archiveState) error {
	var failures int
	var deleted int
	var deletedParts int
	var freed int64
	now := time.Now()

	for _, ch := range channels {
		dir := filepath.Join(archiveRoot, strconv.FormatUint(uint64(ch.ID), 10))
		entries, err := os.ReadDir(dir)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			failures++
			continue
		}

		hours := ch.Record
		if hours < 0 {
			hours = 0
		}
		// Избегаем переполнения time.Duration для некорректных record.
		const maxHours = int64(100 * 365 * 24)
		if hours > maxHours {
			hours = maxHours
		}
		cutoff := now.Add(-time.Duration(hours) * time.Hour).Unix()

		for _, entry := range entries {
			if !entry.Type().IsRegular() {
				continue
			}
			name := entry.Name()
			isPart := strings.HasSuffix(name, ".ts.part")
			isTS := !isPart && strings.HasSuffix(name, ".ts")
			if !isPart && !isTS {
				continue
			}

			suffix := ".ts"
			if isPart {
				suffix = ".ts.part"
			}
			ts, err := strconv.ParseInt(strings.TrimSuffix(name, suffix), 10, 64)
			if err != nil || ts <= 0 {
				continue
			}

			filename := filepath.Join(dir, name)
			st, err := os.Lstat(filename)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil || !st.Mode().IsRegular() {
				failures++
				continue
			}

			if isPart {
				// Текущий .part может быть открыт на запись.
				if state := states[ch.ID]; state != nil &&
					state.file != nil && state.partPath == filename {
					continue
				}
				// Даём возможность восстановить недавний .part
				// после рестарта или кратковременной потери UDP.
				if now.Sub(st.ModTime()) < archiveOrphanPartAge {
					continue
				}
			} else if ts >= cutoff {
				continue
			}

			if err := os.Remove(filename); err != nil {
				failures++
				continue
			}
			deleted++
			if isPart {
				deletedParts++
			}
			freed += st.Size()
		}
	}

	if debug {
		slog(fmt.Sprintf(
			"Archive cleanup: deleted=%d (orphan_parts=%d) freed=%.2f GiB",
			deleted, deletedParts, float64(freed)/(1<<30),
		))
	}
	if failures > 0 {
		return fmt.Errorf("%d filesystem errors", failures)
	}
	return nil
}
