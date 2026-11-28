package models

// ChannelPackage — связь многие-ко-многим между каналами и пакетами.
// Составной первичный ключ исключает повторную привязку канала к пакету.
type ChannelPackage struct {
	ChannelID uint32 `gorm:"column:channel_id;type:int unsigned;primaryKey;autoIncrement:false;not null" json:"channel_id"`
	PackageID uint32 `gorm:"column:package_id;type:int unsigned;primaryKey;autoIncrement:false;not null;index:idx_channel_packages_package_id" json:"package_id"`

	Channel Channel `gorm:"foreignKey:ChannelID;references:ID;constraint:fk_channel_packages_channel,OnUpdate:CASCADE,OnDelete:CASCADE;" json:"-"`
	Package Package `gorm:"foreignKey:PackageID;references:ID;constraint:fk_channel_packages_package,OnUpdate:CASCADE,OnDelete:CASCADE;" json:"-"`
}

func (ChannelPackage) TableName() string { return "channel_packages" }
