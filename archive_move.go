package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"main/models"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A transfer is deliberately serialized per channel. It is kept in memory;
// an interrupted transfer leaves any not-yet-moved source files intact.
type archiveMoveJob struct {
	ChannelID     uint32    `json:"channel_id"`
	FromStorageID uint      `json:"from_storage_id"`
	ToStorageID   uint      `json:"to_storage_id"`
	State         string    `json:"state"`
	Total         int       `json:"total"`
	Moved         int       `json:"moved"`
	MovedBytes    int64     `json:"moved_bytes"`
	Error         string    `json:"error,omitempty"`
	UpdatedAt     time.Time `json:"updated_at"`
}

var archiveMoves = struct {
	sync.RWMutex
	jobs map[uint32]archiveMoveJob
}{jobs: make(map[uint32]archiveMoveJob)}

func archiveMoveActive(channelID uint32) bool {
	archiveMoves.RLock()
	defer archiveMoves.RUnlock()
	job, exists := archiveMoves.jobs[channelID]
	return exists && (job.State == "waiting" || job.State == "running")
}

func startArchiveMove(channelID uint32, from models.Storage, to models.Storage) error {
	if from.ID == to.ID || filepath.Clean(from.Path) == filepath.Clean(to.Path) {
		return errors.New("source and destination are the same")
	}
	if _, err := archivePathReady(from.Path); err != nil {
		return fmt.Errorf("source storage: %w", err)
	}
	if _, err := archivePathReady(to.Path); err != nil {
		return fmt.Errorf("destination storage: %w", err)
	}
	archiveMoves.Lock()
	if job, ok := archiveMoves.jobs[channelID]; ok && (job.State == "waiting" || job.State == "running") {
		archiveMoves.Unlock()
		return errors.New("archive transfer is already running for this channel")
	}
	archiveMoves.jobs[channelID] = archiveMoveJob{ChannelID: channelID, FromStorageID: from.ID, ToStorageID: to.ID, State: "waiting", UpdatedAt: time.Now()}
	archiveMoves.Unlock()
	go executeArchiveMove(channelID, from, to)
	return nil
}

func setArchiveMove(channelID uint32, update func(*archiveMoveJob)) {
	archiveMoves.Lock()
	job := archiveMoves.jobs[channelID]
	update(&job)
	job.UpdatedAt = time.Now()
	archiveMoves.jobs[channelID] = job
	archiveMoves.Unlock()
}

// POST {"op":"adminChannelArchiveMoveStatus","id":77}
func apiAdminChannelArchiveMoveStatus(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	id, err := parseChannelID(ctx.D["id"])
	if err != nil {
		return channelError(ctx, "Invalid channel ID")
	}
	archiveMoves.RLock()
	job, exists := archiveMoves.jobs[id]
	archiveMoves.RUnlock()
	if !exists {
		ctx.Out["job"] = nil
	} else {
		ctx.Out["job"] = job
	}
	return ctx.Out
}

func executeArchiveMove(channelID uint32, from, to models.Storage) {
	if err := moveArchiveFiles(channelID, from, to); err != nil {
		setArchiveMove(channelID, func(job *archiveMoveJob) { job.State = "error"; job.Error = err.Error() })
		slog(fmt.Sprintf("Archive move %d: %v", channelID, err), "error")
	} else {
		setArchiveMove(channelID, func(job *archiveMoveJob) { job.State = "done" })
		slog(fmt.Sprintf("Archive move %d: completed", channelID), "info")
	}
}

func moveArchiveFiles(channelID uint32, from, to models.Storage) error {
	channelFolder := strconv.FormatUint(uint64(channelID), 10)
	srcDir := filepath.Join(from.Path, channelFolder)
	dstDir := filepath.Join(to.Path, channelFolder)
	if srcDir == dstDir || strings.HasPrefix(dstDir+string(os.PathSeparator), srcDir+string(os.PathSeparator)) || strings.HasPrefix(srcDir+string(os.PathSeparator), dstDir+string(os.PathSeparator)) {
		return errors.New("overlapping archive directories")
	}
	if _, err := archivePathReady(from.Path); err != nil {
		return err
	}
	if _, err := archivePathReady(to.Path); err != nil {
		return err
	}
	if err := checkStoragePathSymlinks(srcDir); err != nil {
		return err
	}
	// The recording worker polls every two seconds; after the DB update it
	// closes the old .ts.part. Never move a file still being written.
	deadline := time.Now().Add(45 * time.Second)
	for {
		var ch models.Channel
		if err := db.Select("id", "storage_id").First(&ch, channelID).Error; err != nil {
			return err
		}
		if ch.StorageID == nil || *ch.StorageID != to.ID {
			return errors.New("channel storage changed again during transfer")
		}
		entries, err := os.ReadDir(srcDir)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		pending := false
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".ts.part") {
				info, infoErr := e.Info()
				if infoErr != nil {
					return infoErr
				}
				// A stale .part is left untouched but does not block moving finalized files.
				if time.Since(info.ModTime()) < 12*time.Second {
					pending = true
					break
				}
			}
		}
		if !pending {
			break
		}
		if time.Now().After(deadline) {
			return errors.New("source still contains .ts.part files; transfer stopped without touching them")
		}
		time.Sleep(2 * time.Second)
	}
	if err := os.MkdirAll(dstDir, 0750); err != nil {
		return err
	}
	if err := checkStoragePathSymlinks(dstDir); err != nil {
		return err
	}
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return err
	}
	files := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasSuffix(e.Name(), ".ts") && validArchiveTSName(e.Name()) {
			files = append(files, e.Name())
		}
	}
	setArchiveMove(channelID, func(job *archiveMoveJob) { job.State = "running"; job.Total = len(files) })
	for _, name := range files {
		var ch models.Channel
		if err := db.Select("id", "storage_id").First(&ch, channelID).Error; err != nil {
			return err
		}
		if ch.StorageID == nil || *ch.StorageID != to.ID {
			return errors.New("storage changed during transfer")
		}
		src := filepath.Join(srcDir, name)
		dst := filepath.Join(dstDir, name)
		n, err := transferArchiveFile(src, dst)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		setArchiveMove(channelID, func(job *archiveMoveJob) { job.Moved++; job.MovedBytes += n })
	}
	// Preserve directory if non-archive files or active recordings remain.
	_ = os.Remove(srcDir)
	return nil
}

func validArchiveTSName(name string) bool {
	digits := strings.TrimSuffix(name, ".ts")
	if digits == name || len(digits) < 1 || len(digits) > 20 {
		return false
	}
	_, err := strconv.ParseUint(digits, 10, 64)
	return err == nil
}

// Copy to an unpublished temporary file, fsync it, publish it without
// overwriting an existing minute, then delete the source. A failed transfer
// retains the source; a retry can safely accept an identical destination.
func transferArchiveFile(src, dst string) (int64, error) {
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	before, err := in.Stat()
	if err != nil {
		return 0, err
	}
	if !before.Mode().IsRegular() {
		return 0, errors.New("source is not a regular file")
	}
	// If destination already exists, verify equality instead of overwriting it.
	if destinationInfo, err := os.Lstat(dst); err == nil {
		if !destinationInfo.Mode().IsRegular() {
			return 0, errors.New("destination is not a regular file")
		}
		equal, e := sameArchiveContents(in, dst, before.Size())
		if e != nil {
			return 0, e
		}
		if !equal {
			return 0, errors.New("destination minute exists with different content; source preserved")
		}
		if err := os.Remove(src); err != nil {
			return 0, err
		}
		return before.Size(), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	out, err := os.CreateTemp(filepath.Dir(dst), ".archive-move-*")
	if err != nil {
		return 0, err
	}
	temp := out.Name()
	defer os.Remove(temp)
	hashSrc := sha256.New()
	copied, copyErr := io.Copy(out, io.TeeReader(in, hashSrc))
	if copyErr != nil {
		out.Close()
		return 0, copyErr
	}
	if copied != before.Size() {
		out.Close()
		return 0, errors.New("source size changed during copy")
	}
	after, e := in.Stat()
	if e != nil || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		out.Close()
		return 0, errors.New("source modified during copy")
	}
	if err := out.Chmod(before.Mode().Perm()); err != nil {
		out.Close()
		return 0, err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return 0, err
	}
	if err := out.Close(); err != nil {
		return 0, err
	}
	// os.Link is atomic and will fail rather than clobber an existing file.
	if err := os.Link(temp, dst); err != nil {
		if errors.Is(err, os.ErrExist) {
			return 0, errors.New("destination appeared during transfer; source preserved")
		}
		return 0, err
	}
	// Verify bytes from the published destination before removing source.
	verify, err := os.Open(dst)
	if err != nil {
		return 0, err
	}
	hashDst := sha256.New()
	_, err = io.Copy(hashDst, verify)
	closeErr := verify.Close()
	if err != nil {
		return 0, err
	}
	if closeErr != nil {
		return 0, closeErr
	}
	if !equalHash(hashSrc.Sum(nil), hashDst.Sum(nil)) {
		return 0, errors.New("destination checksum mismatch; source preserved")
	}
	if err := os.Remove(src); err != nil {
		return 0, err
	}
	return copied, nil
}

func equalHash(a, b []byte) bool { return string(a) == string(b) }

func sameArchiveContents(in *os.File, dst string, expectedSize int64) (bool, error) {
	out, err := os.Open(dst)
	if err != nil {
		return false, err
	}
	defer out.Close()
	info, err := out.Stat()
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Size() != expectedSize {
		return false, nil
	}
	if _, err := in.Seek(0, io.SeekStart); err != nil {
		return false, err
	}
	first := sha256.New()
	if _, err := io.Copy(first, in); err != nil {
		return false, err
	}
	second := sha256.New()
	if _, err := io.Copy(second, out); err != nil {
		return false, err
	}
	return equalHash(first.Sum(nil), second.Sum(nil)), nil
}
