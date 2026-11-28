package main

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"main/models"
)

// This monitor is deliberately separate from the recording worker.
// It scans at most once per five minutes and never makes a request wait
// for potentially hundreds of thousands of archived segments.
const archiveSizeRefreshInterval = 5 * time.Minute

type archiveDirSize struct {
	Path  string
	Bytes int64
}

var channelArchiveSizeCache = struct {
	sync.RWMutex
	once  sync.Once
	sizes map[uint32]archiveDirSize
}{sizes: make(map[uint32]archiveDirSize)}

func apiAdminChannelArchiveSizes(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	channelArchiveSizeCache.once.Do(func() {
		go channelArchiveSizeWorker()
	})

	// Include channels regardless of recording state; previously recorded files
	// can remain after recording has been disabled. Do not serve stale sizes
	// if a channel has been moved to another storage.
	var channels []models.Channel
	if err := db.Preload("Storage").Find(&channels).Error; err != nil {
		return channelError(ctx, "Cannot load channel archive sizes")
	}

	channelArchiveSizeCache.RLock()
	sizes := make(map[string]*int64, len(channels))
	for _, channel := range channels {
		key := strconv.FormatUint(uint64(channel.ID), 10)
		var val *int64
		if channel.Storage != nil {
			dir := filepath.Join(channel.Storage.Path, key)
			if cached, ok := channelArchiveSizeCache.sizes[channel.ID]; ok && cached.Path == dir {
				n := cached.Bytes
				val = &n
			}
		}
		sizes[key] = val
	}
	channelArchiveSizeCache.RUnlock()

	ctx.Out["sizes"] = sizes
	return ctx.Out
}

func channelArchiveSizeWorker() {
	scanChannelArchiveSizes()
	ticker := time.NewTicker(archiveSizeRefreshInterval)
	defer ticker.Stop()
	for range ticker.C {
		scanChannelArchiveSizes()
	}
}

func scanChannelArchiveSizes() {
	var channels []models.Channel
	if err := db.Preload("Storage").Find(&channels).Error; err != nil {
		return
	}

	next := make(map[uint32]archiveDirSize, len(channels))
	for _, channel := range channels {
		if channel.Storage == nil || channel.StorageID == nil {
			continue
		}
		ready, err := archivePathReady(channel.Storage.Path)
		if err != nil || !ready {
			continue
		}
		dir := filepath.Join(channel.Storage.Path, strconv.FormatUint(uint64(channel.ID), 10))
		size, err := archiveRegularFilesSize(dir)
		if err != nil {
			continue // unavailable -> null, never display an invented zero
		}
		next[channel.ID] = archiveDirSize{Path: dir, Bytes: size}
	}
	channelArchiveSizeCache.Lock()
	channelArchiveSizeCache.sizes = next
	channelArchiveSizeCache.Unlock()
}

// Sum logical sizes of regular files immediately inside the channel directory.
// This includes .ts and in-progress .ts.part files, excludes symlinks, and
// reads entries in bounded batches instead of loading a full directory at once.
func archiveRegularFilesSize(dir string) (int64, error) {
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return 0, os.ErrNotExist // no directory: API returns null (UI shows dash)
	}
	if err != nil {
		return 0, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return 0, errors.New("archive channel directory is not a real directory")
	}
	f, err := os.Open(dir)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	var total int64
	for {
		entries, readErr := f.ReadDir(256)
		for _, entry := range entries {
			if !entry.Type().IsRegular() && entry.Type() != 0 {
				continue
			}
			fileInfo, err := entry.Info()
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					continue
				} // rotated while scanning
				return 0, err
			}
			if fileInfo.Mode().IsRegular() {
				total += fileInfo.Size()
			}
		}
		if readErr == io.EOF {
			return total, nil
		}
		if readErr != nil {
			return 0, readErr
		}
	}
}
