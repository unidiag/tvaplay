package models

var AllModels = []any{
	&Setting{},
	&User{},
	&UserRefreshToken{},

	&EPGChannel{},
	&EPGProgramme{},

	&Channel{},
	&Package{},
	&ChannelPackage{},
	&UserPackage{},

	&DailyBalanceCharge{},
}
