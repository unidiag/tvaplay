package main

import "time"

func systemMonitorError(
	ctx *ApiCtx,
	message string,
) map[string]any {
	ctx.Out["status"] = "NOK"
	ctx.Out["message"] = message

	return ctx.Out
}

func systemSnapshotReady(
	snapshot SystemMonitorSnapshot,
) bool {
	return snapshot.UpdatedAt > 0 &&
		time.Now().Unix()-snapshot.UpdatedAt <= 20
}

// ============================================================
// CPU / RAM
// ============================================================

// POST {"op":"adminSystemCPU"}
func apiAdminSystemCPU(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	snapshot := getSystemMonitorSnapshot()

	if !systemSnapshotReady(snapshot) {
		return systemMonitorError(
			ctx,
			"System monitoring data is unavailable",
		)
	}

	if snapshot.CPUErr != "" {
		return systemMonitorError(
			ctx,
			snapshot.CPUErr,
		)
	}

	ctx.Out["hostname"] = snapshot.Hostname
	ctx.Out["cpu"] = snapshot.CPU
	ctx.Out["memory"] = snapshot.Memory
	ctx.Out["load_average"] = snapshot.LoadAverage
	ctx.Out["uptime"] = snapshot.Uptime
	ctx.Out["updated_at"] = snapshot.UpdatedAt
	ctx.Out["interval_seconds"] = 5

	return ctx.Out
}

// ============================================================
// NETWORK INTERFACES
// ============================================================

// POST {"op":"adminSystemInterfaces"}
func apiAdminSystemInterfaces(
	ctx *ApiCtx,
) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	snapshot := getSystemMonitorSnapshot()

	if !systemSnapshotReady(snapshot) {
		return systemMonitorError(
			ctx,
			"System monitoring data is unavailable",
		)
	}

	if snapshot.InterfacesErr != "" {
		return systemMonitorError(
			ctx,
			snapshot.InterfacesErr,
		)
	}

	ctx.Out["interfaces"] = snapshot.Interfaces
	ctx.Out["updated_at"] = snapshot.UpdatedAt
	ctx.Out["interval_seconds"] = 5

	return ctx.Out
}
