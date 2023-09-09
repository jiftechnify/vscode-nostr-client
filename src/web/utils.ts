import { getUnixTime } from "date-fns";

export const currUnixtime = () => getUnixTime(new Date());

export const currUnixtimeMilli = Date.now;

export const mapFalsyToUndefined = <T>(v: T): T | undefined =>
  v ? v : undefined;
