package main

import (
	"context"
	"log"
	"main/models"
	"time"

	"gorm.io/gorm/clause"
)

const storageMetricsRetention = 7 * 24 * time.Hour

// Called once from startStorageIOWorker, after DB initialization.
// Never call this from an HTTP handler.
func startStorageMetricsWorker() {
	go func() {
		// Wait for the first complete minute and let the diskstats monitor
		// accumulate a full rolling window before inserting a sample.
		nextMinute := time.Now().Truncate(time.Minute).Add(time.Minute)
		timer := time.NewTimer(time.Until(nextMinute))
		defer timer.Stop()
		<-timer.C

		// A second worker with a long period avoids a DELETE on every sample.
		// This worker also performs cleanup on the first cycle.
		lastCleanup := time.Time{}
		for {
			// Use the minute boundary as the logical timestamp. UTC avoids
			// ambiguity around DST. The previous minute has just completed.
			minute := time.Now().UTC().Truncate(time.Minute).Add(-time.Minute)
			if err := saveStorageMetrics(minute); err != nil {
				log.Printf("[STORAGE METRICS] save: %v", err)
			}
			if lastCleanup.IsZero() || time.Since(lastCleanup) >= time.Hour {
				cutoff := time.Now().UTC().Add(-storageMetricsRetention)
				if err := db.Where("minute < ?", cutoff).Delete(&models.StorageMetric{}).Error; err != nil {
					log.Printf("[STORAGE METRICS] cleanup: %v", err)
				} else {
					lastCleanup = time.Now()
				}
			}

			next := time.Now().Truncate(time.Minute).Add(time.Minute)
			timer.Reset(time.Until(next))
			<-timer.C
		}
	}()
}

func saveStorageMetrics(minute time.Time) error {
	var storages []models.Storage
	if err := db.Select("id", "path").Find(&storages).Error; err != nil {
		return err
	}

	type resolvedDisk struct {
		device string
		err    error
	}
	resolved := make(map[string]resolvedDisk, len(storages))
	rows := make([]models.StorageMetric, 0, len(storages))

	for _, storage := range storages {
		result, ok := resolved[storage.Path]
		if !ok {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			result.device, result.err = storageSMARTDevice(ctx, storage.Path)
			cancel()
			resolved[storage.Path] = result
		}
		if result.err != nil {
			log.Printf("[STORAGE METRICS] storage=%d device: %v", storage.ID, result.err)
			continue
		}

		average := currentStorageIO(result.device)
		if !average.Available || average.WindowSeconds < 55 {
			// Do not store fabricated zero readings during startup,
			// disconnection, stalled monitoring, or counter resets.
			continue
		}

		used, total, err := storageFilesystemSize(storage.Path)
		if err != nil || total == 0 {
			log.Printf("[STORAGE METRICS] storage=%d filesystem: %v", storage.ID, err)
			continue
		}

		rows = append(rows, models.StorageMetric{
			StorageID:        storage.ID,
			Minute:           minute,
			Device:           result.device,
			ReadBytesPerSec:  average.ReadBytesPerSec,
			WriteBytesPerSec: average.WriteBytesPerSec,
			UtilPercent:      average.UtilPercent,
			WindowSeconds:    average.WindowSeconds,
			SizeUsedBytes:    used,
			SizeTotalBytes:   total,
		})
	}
	if len(rows) == 0 {
		return nil
	}

	// Unique (storage_id, minute) protects against duplicate inserts.
	// This also makes save idempotent after transient retry/restart.
	return db.Clauses(clause.OnConflict{DoNothing: true}).CreateInBatches(rows, 100).Error
}
