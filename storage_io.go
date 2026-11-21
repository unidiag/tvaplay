package main

import (
	"bufio"
	"context"
	"main/models"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// diskstats is the same Linux kernel source used by iostat. Reading the
// counters once per second is lighter and more reliable than spawning iostat.
type diskIOCounters struct {
	readSectors  uint64
	writeSectors uint64
	busyMillis   uint64
}

type diskIOSample struct {
	at       time.Time
	counters diskIOCounters
}

type diskIOAverage struct {
	ReadBytesPerSec  float64
	WriteBytesPerSec float64
	WindowSeconds    float64
	UtilPercent      float64
	Available        bool
}

var storageIOMonitor struct {
	sync.RWMutex
	once    sync.Once
	history map[string][]diskIOSample
}

// Call exactly once after database startup. The monitor does not touch MySQL.
func startStorageIOWorker() {
	storageIOMonitor.once.Do(func() {
		storageIOMonitor.Lock()
		storageIOMonitor.history = make(map[string][]diskIOSample)
		storageIOMonitor.Unlock()
		go func() {
			sampleStorageIO()
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for range ticker.C {
				sampleStorageIO()
			}
		}()
		startStorageMetricsWorker()
	})
}

func readStorageDiskstats() (map[string]diskIOCounters, error) {
	f, err := os.Open("/proc/diskstats")
	if err != nil {
		return nil, err
	}
	defer f.Close()

	stats := make(map[string]diskIOCounters)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		// 3 identifiers + the standard 11 counters, of which we need 6 and 10.
		if len(fields) < 14 {
			continue
		}
		name := fields[2]
		// Select only whole kernel disks, not partitions (avoids double count).
		if _, err := os.Stat(filepath.Join("/sys/block", name)); err != nil {
			continue
		}
		read, errR := strconv.ParseUint(fields[5], 10, 64)
		write, errW := strconv.ParseUint(fields[9], 10, 64)
		busy, errB := strconv.ParseUint(fields[12], 10, 64)
		if errR != nil || errW != nil || errB != nil {
			continue
		}
		stats[name] = diskIOCounters{readSectors: read, writeSectors: write, busyMillis: busy}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return stats, nil
}

func sampleStorageIO() {
	counters, err := readStorageDiskstats()
	if err != nil {
		return
	}
	now := time.Now()
	storageIOMonitor.Lock()
	defer storageIOMonitor.Unlock()
	for name, counter := range counters {
		samples := append(storageIOMonitor.history[name], diskIOSample{at: now, counters: counter})
		// Keep 60 seconds of history plus the nearest older sample.
		cutoff := now.Add(-60 * time.Second)
		remove := 0
		for remove+1 < len(samples) && samples[remove+1].at.Before(cutoff) {
			remove++
		}
		if remove != 0 {
			samples = append([]diskIOSample(nil), samples[remove:]...)
		}
		storageIOMonitor.history[name] = samples
	}
	for name := range storageIOMonitor.history {
		if _, ok := counters[name]; !ok {
			delete(storageIOMonitor.history, name)
		}
	}
}

func currentStorageIO(device string) diskIOAverage {
	name := filepath.Base(device)
	storageIOMonitor.RLock()
	samples := storageIOMonitor.history[name]
	if len(samples) < 2 {
		storageIOMonitor.RUnlock()
		return diskIOAverage{}
	}
	oldest, newest := samples[0], samples[len(samples)-1]
	storageIOMonitor.RUnlock()
	seconds := newest.at.Sub(oldest.at).Seconds()
	if seconds <= 0 || time.Since(newest.at) > 5*time.Second ||
		newest.counters.readSectors < oldest.counters.readSectors ||
		newest.counters.writeSectors < oldest.counters.writeSectors ||
		newest.counters.busyMillis < oldest.counters.busyMillis {
		return diskIOAverage{}
	}
	// diskstats sectors are always 512 bytes even on 4K-sector disks.
	const sectorBytes = 512.0
	// Linux /proc/diskstats field 10 (index 12 after major/minor/name):
	// milliseconds spent servicing I/O. This is the source of iostat %util.
	util := float64(newest.counters.busyMillis-oldest.counters.busyMillis) / (seconds * 1000) * 100
	if util < 0 {
		util = 0
	} else if util > 100 {
		util = 100 // scheduler/accounting granularity may produce >100% briefly
	}
	return diskIOAverage{
		ReadBytesPerSec:  float64(newest.counters.readSectors-oldest.counters.readSectors) * sectorBytes / seconds,
		WriteBytesPerSec: float64(newest.counters.writeSectors-oldest.counters.writeSectors) * sectorBytes / seconds,
		WindowSeconds:    seconds,
		UtilPercent:      util,
		Available:        true,
	}
}

type storageIORow struct {
	ID               uint    `json:"id"`
	Device           string  `json:"device,omitempty"`
	ReadBytesPerSec  float64 `json:"read_bytes_per_sec"`
	WriteBytesPerSec float64 `json:"write_bytes_per_sec"`
	WindowSeconds    float64 `json:"window_seconds"`
	UtilPercent      float64 `json:"util_percent"`
	Available        bool    `json:"available"`
	Error            string  `json:"error,omitempty"`
}

// POST {"op":"adminStorageIO"}
// Read-only cached metrics. Each storage ID resolves to the physical disk
// backing its filesystem, including root filesystem on NVMe.
func apiAdminStorageIO(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	var storages []models.Storage
	if err := db.Select("id", "path").Order("id ASC").Find(&storages).Error; err != nil {
		return storageError(ctx, "NOK", "Cannot load storages")
	}
	rows := make([]storageIORow, 0, len(storages))
	resolved := make(map[string]struct {
		device string
		err    error
	})
	for _, storage := range storages {
		row := storageIORow{ID: storage.ID}
		entry, ok := resolved[storage.Path]
		if !ok {
			c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			device, err := storageSMARTDevice(c, storage.Path)
			cancel()
			entry = struct {
				device string
				err    error
			}{device, err}
			resolved[storage.Path] = entry
		}
		if entry.err != nil {
			row.Error = "Cannot determine physical disk: " + entry.err.Error()
		} else {
			row.Device = entry.device
			value := currentStorageIO(entry.device)
			row.Available = value.Available
			row.ReadBytesPerSec = value.ReadBytesPerSec
			row.WriteBytesPerSec = value.WriteBytesPerSec
			row.WindowSeconds = value.WindowSeconds
			row.UtilPercent = value.UtilPercent
			if !value.Available {
				row.Error = "Collecting I/O samples"
			}
		}
		rows = append(rows, row)
	}
	ctx.Out["io"] = rows
	return ctx.Out
}
