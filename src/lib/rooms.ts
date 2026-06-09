import type { Room } from "@/lib/types";

export function inferRoomMeta(roomNumber: string, sourceName = "") {
  const normalized = roomNumber.trim();
  const match = normalized.match(/^([A-Za-z])\s*(\d+)-(\d+)/);

  if (!match) {
    const source = sourceName.trim().toLowerCase();
    return {
      building: source.includes("橋") || source.includes("桥")
        ? "橋下"
        : source.includes("a")
          ? "A棟"
          : source.includes("b")
            ? "B棟"
            : "",
      floor: ""
    };
  }

  return {
    building: `${match[1].toUpperCase()}棟`,
    floor: `${match[2]}樓`
  };
}

export function getRoomBuilding(room: Pick<Room, "building" | "room_number"> | null | undefined) {
  if (!room) return "";
  return room.building || inferRoomMeta(room.room_number).building;
}
