package models

// ChannelPackage — связь многие-ко-многим между каналами и пакетами.
// Составной первичный ключ исключает повторную привязку канала к пакету.
type ChannelPackage struct {
	ChannelID uint32 `gorm:"column:channel_id;type:int unsigned;primaryKey;not null" json:"channel_id"`
	PackageID uint32 `gorm:"column:package_id;type:int unsigned;primaryKey;not null;index" json:"package_id"`
}

func (ChannelPackage) TableName() string { return "channel_packages" }
