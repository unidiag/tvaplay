package models

import "time"

// Package — набор телевизионных каналов.
// Пакет пока не влияет на авторизацию и выдачу плейлиста.
type Package struct {
	ID uint32 `gorm:"column:id;type:int unsigned;primaryKey;autoIncrement" json:"id"`

	Name         string `gorm:"column:name;type:varchar(255);not null" json:"name"`
	Code         string `gorm:"column:code;type:varchar(64);not null;uniqueIndex" json:"code"`
	Description  string `gorm:"column:description;type:text" json:"description"`
	MonthlyPrice string `gorm:"column:monthly_price;type:decimal(10,2);not null;default:0.00" json:"monthly_price"`
	Position     uint16 `gorm:"column:position;type:smallint unsigned;not null;default:0" json:"position"`
	Enabled      uint8  `gorm:"column:enabled;type:tinyint unsigned;not null;default:1" json:"enabled"`
	Optional     bool   `gorm:"column:optional;type:boolean;not null;default:false" json:"optional"`
	ForNew       bool   `gorm:"column:for_new;type:boolean;not null;default:false" json:"for_new"`

	Channels []Channel `gorm:"many2many:channel_packages;joinForeignKey:PackageID;joinReferences:ChannelID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE;" json:"channels,omitempty"`

	CreatedAt time.Time `gorm:"column:created_at;autoCreateTime" json:"created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at;autoUpdateTime" json:"updated_at"`
}

func (Package) TableName() string { return "packages" }
