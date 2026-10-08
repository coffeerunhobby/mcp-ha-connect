/**
 * Time-range windows <-> Omada's per-day schedule entries.
 */

import { describe, it, expect } from 'vitest';

import { buildTimeRange, describeTimeRange, parseTime, type Day } from '../../src/omadaClient/timeRange.js';

describe('parseTime', () => {
    it('reads quarter hours, including 24:00', () => {
        expect(parseTime('00:00')).toBe(0);
        expect(parseTime('14:30')).toBe(870);
        expect(parseTime('9:45')).toBe(585);
        expect(parseTime('24:00')).toBe(1440);
    });

    it.each([
        ['14:10', /quarter hours/],
        ['14:60', /quarter hours/],
        ['24:15', /past 24:00/],
        ['1430', /HH:MM/],
        ['', /HH:MM/],
    ])('refuses %s', (value, error) => {
        expect(() => parseTime(value)).toThrow(error);
    });
});

describe('buildTimeRange', () => {
    it('turns windows into custom per-day entries, merging overlaps', () => {
        const body = buildTimeRange('Study', [
            { days: ['mon', 'wed'], start: '08:00', end: '10:00' },
            { days: ['mon'], start: '09:30', end: '11:00' },
        ]);

        expect(body).toEqual({
            name: 'Study',
            dayMode: 3,
            customDayMode: { dayMon: true, dayTue: false, dayWed: true, dayThu: false, dayFri: false, daySat: false, daySun: false },
            timeList: [
                { dayType: 1, startTimeH: 8, startTimeM: 0, endTimeH: 11, endTimeM: 0 },
                { dayType: 3, startTimeH: 8, startTimeM: 0, endTimeH: 10, endTimeM: 0 },
            ],
        });
    });

    it('inverts allowed hours into the blocked ones (the live curfew morning profile)', () => {
        // Free from the start of play time to midnight -> blocked from midnight to the start of play time.
        const body = buildTimeRange(
            'Curfew morning',
            [
                { days: ['mon', 'tue', 'wed', 'thu'], start: '14:30', end: '24:00' },
                { days: ['fri'], start: '14:00', end: '24:00' },
                { days: ['sat'], start: '09:00', end: '24:00' },
                { days: ['sun'], start: '10:00', end: '24:00' },
            ],
            true
        );

        expect(describeTimeRange(body)).toEqual([
            'mon 00:00-14:30',
            'tue 00:00-14:30',
            'wed 00:00-14:30',
            'thu 00:00-14:30',
            'fri 00:00-14:00',
            'sat 00:00-09:00',
            'sun 00:00-10:00',
        ]);
        expect(Object.values(body.customDayMode!).every(Boolean)).toBe(true);
    });

    it('refuses a whole inverted curfew week in one profile: Omada holds at most 7 windows', () => {
        const allowed = [
            { days: ['mon', 'tue', 'wed', 'thu'] as Day[], start: '14:30', end: '19:00' },
            { days: ['fri'] as Day[], start: '14:00', end: '19:30' },
            { days: ['sat'] as Day[], start: '09:00', end: '19:00' },
            { days: ['sun'] as Day[], start: '10:00', end: '19:00' },
        ];

        expect(() => buildTimeRange('Curfew', allowed, true)).toThrow(
            /needs 14 time windows, but an Omada time range holds at most 7\. Split it into two time ranges.*Nothing was sent/
        );
    });

    it('accepts 7 windows, two on one day, and refuses 8', () => {
        const seven = buildTimeRange('Seven', [
            { days: ['mon'], start: '08:00', end: '09:00' },
            { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '20:00', end: '21:00' },
        ]);
        expect(seven.timeList).toHaveLength(7);

        expect(() =>
            buildTimeRange('Eight', [
                { days: ['mon', 'tue'], start: '08:00', end: '09:00' },
                { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], start: '20:00', end: '21:00' },
            ])
        ).toThrow(/needs 8 time windows/);
    });

    it('inverting covers whole days that have no free window', () => {
        const body = buildTimeRange('Weekend only', [{ days: ['sat', 'sun'], start: '00:00', end: '24:00' }], true);

        expect(describeTimeRange(body)).toEqual(['mon 00:00-24:00', 'tue 00:00-24:00', 'wed 00:00-24:00', 'thu 00:00-24:00', 'fri 00:00-24:00']);
        expect(body.customDayMode).toMatchObject({ daySat: false, daySun: false });
    });

    it.each([
        ['an end before the start', [{ days: ['mon'], start: '19:00', end: '14:00' }], false, /end must be after the start/],
        ['a window without days', [{ days: [], start: '10:00', end: '11:00' }], false, /has no days/],
        ['an unknown day', [{ days: ['funday'], start: '10:00', end: '11:00' }], false, /Unknown day 'funday'/],
        ['no windows', [], false, /At least one time window/],
        ['an inverted schedule that leaves everything free', [{ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '00:00', end: '24:00' }], true, /covers no time/],
    ])('refuses %s', (_label, windows, invert, error) => {
        expect(() => buildTimeRange('x', windows as never, invert)).toThrow(error);
    });
});

describe('describeTimeRange', () => {
    it('labels entries of the every-day, weekday and weekend modes', () => {
        const entry = { dayType: 0, startTimeH: 18, startTimeM: 0, endTimeH: 19, endTimeM: 0 };

        expect(describeTimeRange({ dayMode: 0, timeList: [entry] })).toEqual(['every day 18:00-19:00']);
        expect(describeTimeRange({ dayMode: 1, timeList: [entry] })).toEqual(['weekdays 18:00-19:00']);
        expect(describeTimeRange({ dayMode: 2, timeList: [entry] })).toEqual(['weekend 18:00-19:00']);
    });

    it('names the every-day mode even when an entry carries a weekday number (the omada_setSsidEnabled 24/7 profile)', () => {
        expect(describeTimeRange({ dayMode: 0, timeList: [{ dayType: 1, startTimeH: 0, startTimeM: 0, endTimeH: 24, endTimeM: 0 }] })).toEqual(['every day 00:00-24:00']);
    });
});
