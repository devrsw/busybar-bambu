import { BusyBar } from "@busy-app/busy-lib";

/** Shared device client. */
export const device = new BusyBar({ addr: __BUSY_ADDR__ });
