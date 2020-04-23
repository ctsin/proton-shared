/* eslint-disable no-param-reassign */
import { differenceInMinutes } from 'date-fns';
import { getInternalDateTimeValue, internalValueToIcalValue } from './vcal';
import { getPropertyTzid, isIcalAllDay, propertyToUTCDate } from './vcalConverter';
import { addDays, addMilliseconds, differenceInCalendarDays, max, MILLISECONDS_IN_MINUTE } from '../date-fns-utc';
import { convertUTCDateTimeToZone, fromUTCDate, toUTCDate } from '../date/timezone';
import { createExdateMap } from './exdate';
import { VcalDateOrDateTimeValue, VcalRruleProperty, VcalVeventComponent } from '../interfaces/calendar/VcalModel';

interface CacheInner {
    dtstart: VcalDateOrDateTimeValue;
    utcStart: Date;
    isAllDay: boolean;
    eventDuration: number;
    modifiedRrule: VcalRruleProperty;
    exdateMap: { [key: number]: boolean };
}

interface RecurringResult {
    localStart: Date;
    localEnd: Date;
    utcStart: Date;
    utcEnd: Date;
    occurrenceNumber: number;
}

interface Cache {
    start: CacheInner;
    iteration: {
        iterator: any;
        result: RecurringResult[];
        interval: number[];
    };
}

const YEAR_IN_MS = Date.UTC(1971, 0, 1);

export const isIcalRecurring = ({ rrule }: VcalVeventComponent) => {
    return !!rrule;
};

export const getIcalRecurrenceId = ({ 'recurrence-id': recurrenceId }: VcalVeventComponent) => {
    return recurrenceId;
};

const isInInterval = (a1: number, a2: number, b1: number, b2: number) => a1 <= b2 && a2 >= b1;

// Special case for when attempting to use occurrences when an rrule does not exist.
// Fake an rrule so that the iteration goes through at least once
const DEFAULT_RRULE = {
    value: {
        freq: 'DAILY',
        count: 1
    }
};

interface FillOccurrencesBetween {
    interval: number[];
    iterator: any;
    eventDuration: number;
    originalDtstart: any;
    isAllDay: boolean;
    exdateMap: { [key: number]: boolean };
}
const fillOccurrencesBetween = ({
    interval: [start, end],
    iterator,
    eventDuration,
    originalDtstart,
    isAllDay,
    exdateMap
}: FillOccurrencesBetween) => {
    const result = [];
    let next;

    // eslint-disable-next-line no-cond-assign
    while ((next = iterator.next())) {
        const localStart = toUTCDate(getInternalDateTimeValue(next));
        if (exdateMap[+localStart]) {
            continue;
        }
        const localEnd = isAllDay ? addDays(localStart, eventDuration) : addMilliseconds(localStart, eventDuration);

        const utcStart = isAllDay
            ? localStart
            : propertyToUTCDate({
                  value: {
                      ...originalDtstart.value,
                      ...fromUTCDate(localStart)
                  },
                  parameters: originalDtstart.parameters
              });

        const utcEnd = isAllDay
            ? localEnd
            : propertyToUTCDate({
                  value: {
                      ...originalDtstart.value,
                      ...fromUTCDate(localEnd)
                  },
                  parameters: originalDtstart.parameters
              });

        if (+utcStart > end) {
            break;
        }

        if (isInInterval(+utcStart, +utcEnd, start, end)) {
            result.push({
                localStart,
                localEnd,
                utcStart,
                utcEnd,
                occurrenceNumber: iterator.occurrence_number
            });
        }
    }
    return result;
};

/**
 * Convert the until property of an rrule to be in the timezone of the start date
 */
const getModifiedUntilRrule = (internalRrule: VcalRruleProperty, startTzid: string): VcalRruleProperty => {
    if (!internalRrule || !internalRrule.value || !internalRrule.value.until || !startTzid) {
        return internalRrule;
    }
    const utcUntil = toUTCDate(internalRrule.value.until);
    const localUntil = convertUTCDateTimeToZone(fromUTCDate(utcUntil), startTzid);
    return {
        ...internalRrule,
        value: {
            ...internalRrule.value,
            until: {
                ...localUntil,
                isUTC: true
            }
        }
    };
};

const getOccurrenceSetup = (component: VcalVeventComponent) => {
    const { dtstart: internalDtstart, dtend: internalDtEnd, rrule: internalRrule, exdate: internalExdate } = component;

    const isAllDay = isIcalAllDay(component);
    const dtstartType = isAllDay ? 'date' : 'date-time';

    // Pretend the (local) date is in UTC time to keep the absolute times.
    const dtstart = internalValueToIcalValue(dtstartType, {
        ...internalDtstart.value,
        isUTC: true
    }) as VcalDateOrDateTimeValue;
    // Since the local date is pretended in UTC time, the until has to be converted into a fake local UTC time too
    const safeRrule = getModifiedUntilRrule(internalRrule || DEFAULT_RRULE, getPropertyTzid(internalDtstart));

    const utcStart = propertyToUTCDate(internalDtstart);
    const rawEnd = propertyToUTCDate(internalDtEnd);
    const modifiedEnd = isAllDay
        ? addDays(rawEnd, -1) // All day event range is non-inclusive
        : rawEnd;
    const utcEnd = max(utcStart, modifiedEnd);

    const eventDuration = isAllDay
        ? differenceInCalendarDays(utcEnd, utcStart)
        : differenceInMinutes(utcEnd, utcStart) * MILLISECONDS_IN_MINUTE;

    return {
        dtstart,
        utcStart,
        isAllDay,
        eventDuration,
        modifiedRrule: safeRrule,
        exdateMap: createExdateMap(internalExdate)
    };
};

interface GetOccurrences {
    component: VcalVeventComponent;
    maxStart?: Date;
    maxCount?: number;
    cache: Partial<Cache>;
}
export const getOccurrences = ({
    component,
    maxStart = new Date(9999, 0, 1),
    maxCount = 1,
    cache = {}
}: GetOccurrences) => {
    if (maxCount <= 0) {
        return [];
    }

    if (!cache.start) {
        cache.start = getOccurrenceSetup(component);
    }

    const { eventDuration, isAllDay, dtstart, modifiedRrule, exdateMap } = cache.start;

    const rrule = internalValueToIcalValue('recur', modifiedRrule.value);
    const iterator = rrule.iterator(dtstart);
    const result = [];

    let next;
    // eslint-disable-next-line no-cond-assign
    while ((next = iterator.next())) {
        const localStart = toUTCDate(getInternalDateTimeValue(next));
        if (exdateMap[+localStart]) {
            continue;
        }
        if (result.length >= maxCount || localStart >= maxStart) {
            break;
        }
        const localEnd = isAllDay ? addDays(localStart, eventDuration) : addMilliseconds(localStart, eventDuration);
        result.push({
            localStart,
            localEnd,
            occurrenceNumber: iterator.occurrence_number
        });
    }
    return result;
};

export const getOccurrencesBetween = (
    component: VcalVeventComponent,
    start: number,
    end: number,
    cache: Partial<Cache> = {}
) => {
    if (!cache.start) {
        cache.start = getOccurrenceSetup(component);
    }

    const { dtstart: originalDtstart } = component;

    const { eventDuration, isAllDay, utcStart, dtstart, modifiedRrule, exdateMap } = cache.start;

    // If it starts after the current end, ignore it
    if (+utcStart > end) {
        return [];
    }

    if (!cache.iteration || start < cache.iteration.interval[0] || end > cache.iteration.interval[1]) {
        const rrule = internalValueToIcalValue('recur', modifiedRrule.value);
        const iterator = rrule.iterator(dtstart);

        const interval = [start - YEAR_IN_MS, end + YEAR_IN_MS];

        try {
            const result = fillOccurrencesBetween({
                interval,
                iterator,
                eventDuration,
                originalDtstart,
                isAllDay,
                exdateMap
            });

            cache.iteration = {
                iterator,
                result,
                interval
            };
        } catch (e) {
            console.error(e);
            // Pretend it was ok
            return [];
        }
    }

    return cache.iteration.result.filter(({ utcStart, utcEnd }) => isInInterval(+utcStart, +utcEnd, start, end));
};
