package models

import "time"

// StorageMetric is one completed 60-second I/O observation per storage.
// Counters represent the whole physical disk; capacity is filesystem-level.
type StorageMetric struct {
	ID               uint64    `gorm:"primaryKey;autoIncrement" json:"id"`
	StorageID        uint      `gorm:"not null;uniqueIndex:ux_storage_metrics_storage_minute,priority:1;index:idx_storage_metrics_storage_time,priority:1" json:"storage_id"`
	Minute           time.Time `gorm:"type:datetime(0);not null;uniqueIndex:ux_storage_metrics_storage_minute,priority:2;index:idx_storage_metrics_storage_time,priority:2;index:idx_storage_metrics_minute" json:"minute"`
	Device           string    `gorm:"size:128;not null" json:"device"`
	ReadBytesPerSec  float64   `gorm:"not null" json:"read_bytes_per_sec"`
	WriteBytesPerSec float64   `gorm:"not null" json:"write_bytes_per_sec"`
	UtilPercent      float64   `gorm:"not null" json:"util_percent"`
	WindowSeconds    float64   `gorm:"not null" json:"window_seconds"`
	SizeUsedBytes    uint64    `gorm:"not null" json:"size_used_bytes"`
	SizeTotalBytes   uint64    `gorm:"not null" json:"size_total_bytes"`
}

func (StorageMetric) TableName() string { return "storage_metrics" }
