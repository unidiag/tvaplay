package main

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"

	"main/models"
)

// archivePathReady проверяет доступность каталога хранилища.
// Разрешена запись на любой файловой системе, включая системный NVMe.
// Сам корневой каталог "/" и символьные ссылки запрещены.
func archivePathReady(path string) (bool, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) == "/" {
		return false, errors.New("invalid archive storage directory")
	}

	clean := filepath.Clean(path)

	if err := checkStoragePathSymlinks(clean); err != nil {
		return false, err
	}

	stat, err := os.Lstat(clean)
	if err != nil {
		return false, err
	}

	if !stat.IsDir() {
		return false, errors.New("archive storage is not a directory")
	}

	return true, nil
}

// archiveStorageForChannel возвращает хранилище,
// назначенное конкретному каналу.
func archiveStorageForChannel(id uint32) (models.Storage, error) {
	var channel models.Channel

	if err := db.Select("id", "storage_id").
		First(&channel, id).Error; err != nil {
		return models.Storage{}, err
	}

	if channel.StorageID == nil {
		return models.Storage{}, errors.New("channel has no storage")
	}

	var storage models.Storage

	if err := db.First(&storage, *channel.StorageID).Error; err != nil {
		return models.Storage{}, err
	}

	ready, err := archivePathReady(storage.Path)
	if err != nil {
		return models.Storage{}, err
	}

	if !ready {
		return models.Storage{}, errors.New(
			"archive storage directory is not ready",
		)
	}

	return storage, nil
}

// archiveChannelDir возвращает директорию архива конкретного канала.
// Например: /mnt/sda/77 или /mnt/hdd/77.
func archiveChannelDir(id uint32) (string, error) {
	storage, err := archiveStorageForChannel(id)
	if err != nil {
		return "", err
	}

	return filepath.Join(
		storage.Path,
		strconv.FormatUint(uint64(id), 10),
	), nil
}
