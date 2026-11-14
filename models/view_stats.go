package models

import "time"

type ViewStat struct {
	ID uint64 `gorm:"primaryKey;autoIncrement"`

	ChannelID uint32 `gorm:"not null;index;index:idx_view_stats_started_type_channel,priority:3"`
	UserID    uint32 `gorm:"not null;index"`

	ViewType string `gorm:"type:enum('live','archive');not null;index:idx_view_stats_started_type_channel,priority:2"`

	ProgrammeID   *uint64
	AuthSessionID *uint64 `gorm:"column:auth_session_id;index"`

	SessionID string  `gorm:"type:char(36);uniqueIndex;not null"`
	IPAddress *string `gorm:"type:varchar(45)"`

	StartedAt  time.Time `gorm:"index:idx_view_stats_started_type_channel,priority:1"`
	LastSeenAt time.Time
	EndedAt    *time.Time

	DurationSec uint32 `gorm:"not null;default:0"`

	CreatedAt time.Time
	UpdatedAt time.Time
}

func (ViewStat) TableName() string {
	return "view_stats"
}
