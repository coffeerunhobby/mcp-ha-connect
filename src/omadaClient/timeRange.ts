/**
 * Time-range profiles in a readable form. Omada stores a schedule as a day mode
 * plus a list of {dayType, startTimeH/M, endTimeH/M} entries in 15-minute steps;
 * tools take and return windows like {days: ['mon', 'tue'], start: '14:30', end: '19:00'}.
 */

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Day = (typeof DAYS)[number];

export interface TimeWindow {
    days: Day[];
    /** "HH:MM", minutes 00/15/30/45 */
    start: string;
    /** "HH:MM", minutes 00/15/30/45; "24:00" is the end of the day */
    end: string;
}

export interface TimeRangeEntry {
    dayType: number;
    startTimeH: number;
    startTimeM: number;
    endTimeH: number;
    endTimeM: number;
}

export interface TimeRangeBody {
    name: string;
    dayMode: number;
    customDayMode?: Record<'dayMon' | 'dayTue' | 'dayWed' | 'dayThu' | 'dayFri' | 'daySat' | 'daySun', boolean>;
    timeList: TimeRangeEntry[];
}

/** Omada day modes: 0 every day, 1 weekdays, 2 weekend, 3 custom (per-day entries). */
const DAY_MODE_CUSTOM = 3;
const DAY_KEYS = ['dayMon', 'dayTue', 'dayWed', 'dayThu', 'dayFri', 'daySat', 'daySun'] as const;
const DAY_END = 24 * 60;

/** "14:30" -> 870. Only quarter hours, 00:00 to 24:00. */
export function parseTime(value: string): number {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) throw new Error(`Time '${value}' must look like HH:MM`);
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    if (Number(match[2]) % 15 !== 0 || Number(match[2]) > 45) {
        throw new Error(`Time '${value}': Omada schedules use quarter hours (minutes 00, 15, 30 or 45)`);
    }
    if (minutes > DAY_END) throw new Error(`Time '${value}' is past 24:00`);
    return minutes;
}

export function formatTime(minutes: number): string {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Per-day sorted, merged [start, end) intervals in minutes. */
function intervalsByDay(windows: TimeWindow[]): Map<number, Array<[number, number]>> {
    if (windows.length === 0) throw new Error('At least one time window is required');
    const byDay = new Map<number, Array<[number, number]>>();
    for (const w of windows) {
        const start = parseTime(w.start);
        const end = parseTime(w.end);
        if (end <= start) throw new Error(`Window ${w.start}-${w.end}: the end must be after the start (split windows that cross midnight)`);
        if (w.days.length === 0) throw new Error(`Window ${w.start}-${w.end} has no days`);
        for (const day of w.days) {
            const index = DAYS.indexOf(day);
            if (index < 0) throw new Error(`Unknown day '${day}'; use ${DAYS.join(', ')}`);
            byDay.set(index + 1, [...(byDay.get(index + 1) ?? []), [start, end]]);
        }
    }
    for (const [day, list] of byDay) {
        list.sort((a, b) => a[0] - b[0]);
        const merged: Array<[number, number]> = [];
        for (const [s, e] of list) {
            const last = merged[merged.length - 1];
            if (last && s <= last[1]) last[1] = Math.max(last[1], e);
            else merged.push([s, e]);
        }
        byDay.set(day, merged);
    }
    return byDay;
}

/**
 * Build the Omada body. With `invert`, the windows are the times to leave free
 * and the profile covers every other time of the week (e.g. a curfew rule that
 * should be active outside the allowed hours).
 */
export function buildTimeRange(name: string, windows: TimeWindow[], invert = false): TimeRangeBody {
    const given = intervalsByDay(windows);
    const covered = new Map<number, Array<[number, number]>>();
    for (let day = 1; day <= 7; day++) {
        const list = given.get(day) ?? [];
        if (!invert) {
            if (list.length) covered.set(day, list);
            continue;
        }
        const gaps: Array<[number, number]> = [];
        let cursor = 0;
        for (const [s, e] of list) {
            if (s > cursor) gaps.push([cursor, s]);
            cursor = Math.max(cursor, e);
        }
        if (cursor < DAY_END) gaps.push([cursor, DAY_END]);
        if (gaps.length) covered.set(day, gaps);
    }
    if (covered.size === 0) throw new Error('The schedule covers no time at all (the windows leave every day free)');

    const timeList: TimeRangeEntry[] = [];
    for (const [day, list] of [...covered.entries()].sort((a, b) => a[0] - b[0])) {
        for (const [s, e] of list) {
            timeList.push({ dayType: day, startTimeH: Math.floor(s / 60), startTimeM: s % 60, endTimeH: Math.floor(e / 60), endTimeM: e % 60 });
        }
    }
    const customDayMode = Object.fromEntries(DAY_KEYS.map((key, i) => [key, covered.has(i + 1)])) as TimeRangeBody['customDayMode'];
    return { name, dayMode: DAY_MODE_CUSTOM, customDayMode, timeList };
}

/** Readable windows of a stored profile, e.g. ["mon 00:00-14:30", ...]. */
export function describeTimeRange(profile: { dayMode?: number; timeList?: TimeRangeEntry[] }): string[] {
    // Only the custom mode reads dayType as a weekday; the other modes name their days.
    const label = (dayType: number): string => {
        const mode = profile.dayMode ?? 0;
        if (mode !== DAY_MODE_CUSTOM) return ['every day', 'weekdays', 'weekend'][mode] ?? `dayMode ${mode}`;
        return dayType >= 1 && dayType <= 7 ? DAYS[dayType - 1] : `dayType ${dayType}`;
    };
    return (profile.timeList ?? []).map(
        (t) => `${label(t.dayType)} ${formatTime(t.startTimeH * 60 + t.startTimeM)}-${formatTime(t.endTimeH * 60 + t.endTimeM)}`
    );
}
