package models

import "time"

// Channel — телевизионный канал.
type Channel struct {
	ID uint32 `gorm:"column:id;type:int unsigned;primaryKey;autoIncrement" json:"id"`

	Name string `gorm:"column:name;type:varchar(255);not null;default:'';index" json:"name"`

	Position uint16 `gorm:"column:position;type:smallint unsigned;not null;default:0" json:"position"`

	UDP string `gorm:"column:udp;type:varchar(255);not null" json:"udp"`
	// Количество часов хранения записи.
	// 0 — запись отключена.
	Record uint16 `gorm:"column:record;type:smallint unsigned;not null;default:0" json:"record"`

	// Видимость канала в TV UI.
	// 0 — скрыт, 1 — отображается.
	Enable uint8 `gorm:"column:enable;type:tinyint unsigned;not null;default:1" json:"enable"`

	EPGID string `gorm:"column:epgid;type:varchar(64);not null;default:'';index" json:"epgid"`

	// Один канал может входить в несколько пакетов.
	// Связь хранится отдельно, в channel_packages.
	Packages []Package `gorm:"many2many:channel_packages;joinForeignKey:ChannelID;joinReferences:PackageID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE;" json:"packages,omitempty"`

	UpdatedAt time.Time `gorm:"column:updated_at;type:timestamp;not null;default:CURRENT_TIMESTAMP;autoUpdateTime" json:"updated_at"`
}

func (Channel) TableName() string {
	return "channels"
}
