"use client";

import { useEffect, useMemo, useState } from "react";

export function useDashboardPagination<T>(items: T[], initialPageSize = 50) {
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [currentPage, items, pageSize]);

  return {
    currentPage,
    endItem: totalItems === 0 ? 0 : Math.min(currentPage * pageSize, totalItems),
    pageItems,
    pageSize,
    setCurrentPage,
    setPageSize,
    startItem: totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1,
    totalItems,
    totalPages
  };
}
