package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const systemMonitorInterval = 5 * time.Second

type SystemCPUCore struct {
	Name    string   `json:"name"`
	Percent *float64 `json:"percent"`
}

type SystemCPUInfo struct {
	Model       string          `json:"model"`
	Cores       int             `json:"cores"`
	Percent     *float64        `json:"percent"`
	Temperature *float64        `json:"temperature"`
	Details     []SystemCPUCore `json:"details"`
}

type SystemMemoryInfo struct {
	Total     uint64  `json:"total"`
	Used      uint64  `json:"used"`
	Available uint64  `json:"available"`
	Percent   float64 `json:"percent"`
	SwapTotal uint64  `json:"swap_total"`
	SwapUsed  uint64  `json:"swap_used"`
}

type SystemInterfaceInfo struct {
	Name          string   `json:"name"`
	MAC           string   `json:"mac"`
	Addresses     []string `json:"addresses"`
	State         string   `json:"state"`
	MTU           int      `json:"mtu"`
	Speed         int64    `json:"speed"`
	RxBytes       uint64   `json:"rx_bytes"`
	TxBytes       uint64   `json:"tx_bytes"`
	RxPackets     uint64   `json:"rx_packets"`
	TxPackets     uint64   `json:"tx_packets"`
	RxErrors      uint64   `json:"rx_errors"`
	TxErrors      uint64   `json:"tx_errors"`
	RxDropped     uint64   `json:"rx_dropped"`
	TxDropped     uint64   `json:"tx_dropped"`
	RxBytesPerSec *float64 `json:"rx_bytes_per_sec"`
	TxBytesPerSec *float64 `json:"tx_bytes_per_sec"`
}

type SystemMonitorSnapshot struct {
	Hostname      string
	CPU           SystemCPUInfo
	Memory        SystemMemoryInfo
	LoadAverage   []float64
	Uptime        float64
	Interfaces    []SystemInterfaceInfo
	UpdatedAt     int64
	CPUErr        string
	InterfacesErr string
}

type systemCPUCounters struct {
	Total uint64
	Idle  uint64
}

type systemNetCounters struct {
	Index int
	Rx    uint64
	Tx    uint64
}

var systemMonitor struct {
	sync.RWMutex
	Snapshot SystemMonitorSnapshot
}

var systemMonitorOnce sync.Once

// ============================================================
// COMMON
// ============================================================

func systemReadText(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}

	return strings.TrimSpace(string(data))
}

func systemParseUint(value string) uint64 {
	n, _ := strconv.ParseUint(value, 10, 64)
	return n
}

func systemReadCPUTemperature() *float64 {
	ctx, cancel := context.WithTimeout(
		context.Background(),
		2*time.Second,
	)
	defer cancel()

	output, err := exec.CommandContext(
		ctx,
		"sensors",
		"-j",
	).Output()

	if err != nil {
		return nil
	}

	var sensors map[string]map[string]json.RawMessage

	if err := json.Unmarshal(output, &sensors); err != nil {
		return nil
	}

	readTemperature := func(raw json.RawMessage) *float64 {
		var values map[string]float64

		if err := json.Unmarshal(raw, &values); err != nil {
			return nil
		}

		var maximum *float64

		for key, value := range values {
			if !strings.HasPrefix(key, "temp") ||
				!strings.HasSuffix(key, "_input") {
				continue
			}

			if math.IsNaN(value) ||
				math.IsInf(value, 0) ||
				value < -50 ||
				value > 150 {
				continue
			}

			if maximum == nil || value > *maximum {
				temp := value
				maximum = &temp
			}
		}

		return maximum
	}

	var maximum *float64

	updateMaximum := func(value *float64) {
		if value == nil {
			return
		}

		if maximum == nil || *value > *maximum {
			maximum = value
		}
	}

	for chip, features := range sensors {
		switch {
		// Intel
		case strings.HasPrefix(chip, "coretemp-"):
			for _, raw := range features {
				updateMaximum(readTemperature(raw))
			}

		// AMD
		case strings.HasPrefix(chip, "k10temp-"),
			strings.HasPrefix(chip, "zenpower-"):

			// Prefer physical die temperature.
			if raw, ok := features["Tdie"]; ok {
				if temp := readTemperature(raw); temp != nil {
					updateMaximum(temp)
					continue
				}
			}

			// Fallback to control temperature.
			if raw, ok := features["Tctl"]; ok {
				updateMaximum(readTemperature(raw))
			}
		}
	}

	return maximum
}

func systemReadCPUModel() string {
	data := systemReadText("/proc/cpuinfo")

	for _, line := range strings.Split(data, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}

		switch strings.TrimSpace(key) {
		case "model name", "Hardware", "Processor":
			return strings.TrimSpace(value)
		}
	}

	return "Unknown"
}

// ============================================================
// CPU
// ============================================================

func systemReadCPU(previous map[string]systemCPUCounters) (
	SystemCPUInfo,
	map[string]systemCPUCounters,
	error,
) {
	result := SystemCPUInfo{
		Model:   systemReadCPUModel(),
		Details: make([]SystemCPUCore, 0),
	}

	current := make(map[string]systemCPUCounters)

	file, err := os.Open("/proc/stat")
	if err != nil {
		return result, current, err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())

		if len(fields) < 5 {
			continue
		}

		name := fields[0]

		if !strings.HasPrefix(name, "cpu") {
			continue
		}

		var total uint64
		var idle uint64

		// user, nice, system, idle, iowait,
		// irq, softirq, steal.
		// guest and guest_nice are already included.
		for i := 1; i < len(fields) && i <= 8; i++ {
			value, err := strconv.ParseUint(fields[i], 10, 64)
			if err != nil {
				return result, current, err
			}

			total += value

			if i == 4 || i == 5 {
				idle += value
			}
		}

		current[name] = systemCPUCounters{
			Total: total,
			Idle:  idle,
		}

		var percent *float64

		if old, ok := previous[name]; ok {
			if total > old.Total && idle >= old.Idle {
				totalDelta := total - old.Total
				idleDelta := idle - old.Idle

				if idleDelta <= totalDelta {
					value := 100 *
						float64(totalDelta-idleDelta) /
						float64(totalDelta)

					percent = &value
				}
			}
		}

		if name == "cpu" {
			result.Percent = percent
		} else {
			result.Cores++

			result.Details = append(
				result.Details,
				SystemCPUCore{
					Name:    name,
					Percent: percent,
				},
			)
		}
	}

	if err := scanner.Err(); err != nil {
		return result, current, err
	}

	if _, ok := current["cpu"]; !ok {
		return result, current,
			fmt.Errorf("CPU counters unavailable")
	}

	return result, current, nil
}

// ============================================================
// MEMORY
// ============================================================

func systemReadMemory() (SystemMemoryInfo, error) {
	var result SystemMemoryInfo

	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return result, err
	}
	defer file.Close()

	values := make(map[string]uint64)

	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())

		if len(fields) < 2 {
			continue
		}

		key := strings.TrimSuffix(fields[0], ":")
		value := systemParseUint(fields[1])

		// Values in /proc/meminfo are usually in KiB.
		if len(fields) >= 3 && fields[2] == "kB" {
			value *= 1024
		}

		values[key] = value
	}

	if err := scanner.Err(); err != nil {
		return result, err
	}

	result.Total = values["MemTotal"]

	if result.Total == 0 {
		return result, fmt.Errorf("MemTotal unavailable")
	}

	available, ok := values["MemAvailable"]
	if !ok {
		available = values["MemFree"]
	}

	if available > result.Total {
		available = result.Total
	}

	result.Available = available
	result.Used = result.Total - available

	result.Percent =
		float64(result.Used) /
			float64(result.Total) * 100

	result.SwapTotal = values["SwapTotal"]

	if free := values["SwapFree"]; free <= result.SwapTotal {
		result.SwapUsed = result.SwapTotal - free
	}

	return result, nil
}

// ============================================================
// LOAD AVERAGE / UPTIME
// ============================================================

func systemReadLoadAverage() []float64 {
	fields := strings.Fields(
		systemReadText("/proc/loadavg"),
	)

	result := make([]float64, 0, 3)

	for i := 0; i < len(fields) && i < 3; i++ {
		value, err := strconv.ParseFloat(fields[i], 64)
		if err != nil {
			return nil
		}

		result = append(result, value)
	}

	return result
}

func systemReadUptime() float64 {
	fields := strings.Fields(
		systemReadText("/proc/uptime"),
	)

	if len(fields) == 0 {
		return 0
	}

	value, _ := strconv.ParseFloat(fields[0], 64)
	return value
}

// ============================================================
// NETWORK INTERFACES
// ============================================================

func systemReadInterfaces(
	previous map[string]systemNetCounters,
	elapsed float64,
) (
	[]SystemInterfaceInfo,
	map[string]systemNetCounters,
	error,
) {
	result := make([]SystemInterfaceInfo, 0)
	current := make(map[string]systemNetCounters)

	interfaces, err := net.Interfaces()
	if err != nil {
		return result, current, err
	}

	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return result, current, err
	}

	counters := make(map[string][]string)

	for _, line := range strings.Split(string(data), "\n") {
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}

		fields := strings.Fields(value)

		if len(fields) >= 16 {
			counters[strings.TrimSpace(name)] = fields
		}
	}

	for _, iface := range interfaces {
		path := filepath.Join(
			"/sys/class/net",
			iface.Name,
		)

		fields, ok := counters[iface.Name]
		if !ok {
			continue
		}

		item := SystemInterfaceInfo{
			Name:      iface.Name,
			MAC:       iface.HardwareAddr.String(),
			MTU:       iface.MTU,
			Addresses: make([]string, 0),
			State: systemReadText(
				filepath.Join(path, "operstate"),
			),

			RxBytes:   systemParseUint(fields[0]),
			RxPackets: systemParseUint(fields[1]),
			RxErrors:  systemParseUint(fields[2]),
			RxDropped: systemParseUint(fields[3]),

			TxBytes:   systemParseUint(fields[8]),
			TxPackets: systemParseUint(fields[9]),
			TxErrors:  systemParseUint(fields[10]),
			TxDropped: systemParseUint(fields[11]),
		}

		if item.State == "" {
			item.State = "unknown"
		}

		item.Speed = -1

		speed, err := strconv.ParseInt(
			systemReadText(filepath.Join(path, "speed")),
			10,
			64,
		)

		if err == nil && speed > 0 {
			item.Speed = speed
		}

		addresses, err := iface.Addrs()
		if err == nil {
			for _, address := range addresses {
				item.Addresses = append(
					item.Addresses,
					address.String(),
				)
			}
		}

		current[iface.Name] = systemNetCounters{
			Index: iface.Index,
			Rx:    item.RxBytes,
			Tx:    item.TxBytes,
		}

		if old, ok := previous[iface.Name]; ok &&
			old.Index == iface.Index &&
			elapsed > 0 {

			if item.RxBytes >= old.Rx {
				value :=
					float64(item.RxBytes-old.Rx) / elapsed

				item.RxBytesPerSec = &value
			}

			if item.TxBytes >= old.Tx {
				value :=
					float64(item.TxBytes-old.Tx) / elapsed

				item.TxBytesPerSec = &value
			}
		}

		result = append(result, item)
	}

	return result, current, nil
}

// ============================================================
// SNAPSHOT
// ============================================================

func getSystemMonitorSnapshot() SystemMonitorSnapshot {
	systemMonitor.RLock()
	defer systemMonitor.RUnlock()

	return systemMonitor.Snapshot
}

// ============================================================
// WORKER
// ============================================================

func startSystemMonitorWorker() {
	systemMonitorOnce.Do(func() {
		go systemMonitorWorker()
	})
}

func systemMonitorWorker() {
	previousCPU := make(map[string]systemCPUCounters)
	previousNet := make(map[string]systemNetCounters)

	var previousNetTime time.Time

	hostname, _ := os.Hostname()

	ticker := time.NewTicker(systemMonitorInterval)
	defer ticker.Stop()

	for {
		now := time.Now()

		snapshot := SystemMonitorSnapshot{
			Hostname:    hostname,
			UpdatedAt:   now.Unix(),
			LoadAverage: systemReadLoadAverage(),
			Uptime:      systemReadUptime(),
		}

		cpu, cpuCounters, cpuErr :=
			systemReadCPU(previousCPU)

		if cpuErr == nil {
			cpu.Temperature = systemReadCPUTemperature()

			snapshot.CPU = cpu
			previousCPU = cpuCounters
		} else {
			snapshot.CPUErr = cpuErr.Error()
			previousCPU = nil
		}

		memory, memoryErr := systemReadMemory()

		if memoryErr == nil {
			snapshot.Memory = memory
		} else {
			if snapshot.CPUErr != "" {
				snapshot.CPUErr += "; "
			}
			snapshot.CPUErr += memoryErr.Error()
		}

		elapsed := 0.0

		if !previousNetTime.IsZero() {
			elapsed = now.Sub(previousNetTime).Seconds()
		}

		interfaces, netCounters, netErr :=
			systemReadInterfaces(previousNet, elapsed)

		if netErr == nil {
			snapshot.Interfaces = interfaces

			previousNet = netCounters
			previousNetTime = now
		} else {
			snapshot.InterfacesErr = netErr.Error()
			previousNet = nil
			previousNetTime = time.Time{}
		}

		systemMonitor.Lock()
		systemMonitor.Snapshot = snapshot
		systemMonitor.Unlock()

		<-ticker.C
	}
}
