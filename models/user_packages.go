package models

// UserPackage links a subscriber to a channel package.
// The composite primary key prevents duplicate subscriptions.
type UserPackage struct {
	UserID    uint   `gorm:"column:user_id;primaryKey;not null" json:"user_id"`
	PackageID uint32 `gorm:"column:package_id;type:int unsigned;primaryKey;not null;index" json:"package_id"`
}

func (UserPackage) TableName() string { return "user_packages" }
