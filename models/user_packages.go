package models

import "time"

// UserPackage links a subscriber to a channel package.
// The composite primary key prevents duplicate subscriptions.
type UserPackage struct {
	UserID uint `gorm:"column:user_id;primaryKey;autoIncrement:false;not null" json:"user_id"`

	PackageID uint32 `gorm:"column:package_id;type:int unsigned;primaryKey;autoIncrement:false;not null;index:idx_user_packages_package_id" json:"package_id"`

	User User `gorm:"foreignKey:UserID;references:ID;constraint:fk_user_packages_user,OnUpdate:CASCADE,OnDelete:CASCADE;" json:"-"`

	Package Package `gorm:"foreignKey:PackageID;references:ID;constraint:fk_user_packages_package,OnUpdate:CASCADE,OnDelete:CASCADE;" json:"-"`

	// Время подключения пакета абонентом.
	// Отключение разрешается через 24 часа.
	// NULL — старое подключение без известной даты.
	EnabledAt *time.Time `gorm:"column:enabled_at;type:datetime(3)" json:"-"`
}

func (UserPackage) TableName() string {
	return "user_packages"
}
