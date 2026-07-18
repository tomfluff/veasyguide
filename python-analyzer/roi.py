# Copyright (C) 2026 Yotam Sechayk
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
import networkx as nx
import numpy as np


class RoINode:
    def __init__(self, time, x, y, width, height, data=None):
        self.time = time
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.data = data

    @property
    def left(self):
        return self.x

    @property
    def right(self):
        return self.x + self.width

    @property
    def top(self):
        return self.y

    @property
    def bottom(self):
        return self.y + self.height

    @property
    def cx(self):
        return self.x + self.width // 2

    @property
    def cy(self):
        return self.y + self.height // 2

    @property
    def radius(self):
        return max(self.width, self.height) // 2

    def add_data(self, key, value):
        if not self.data:
            self.data = {}
        self.data[key] = value

    def distance(self, other):
        dx, dy = 0, 0

        # Distance on X-axis
        if self.right < other.left:
            dx = other.left - self.right
        elif other.right < self.left:
            dx = self.left - other.right
        # Distance on Y-axis
        if self.bottom < other.top:
            dy = other.top - self.bottom
        elif other.bottom < self.top:
            dy = self.top - other.bottom

        return np.sqrt(dx**2 + dy**2)

    def span(self, other):
        return abs(self.time - other.time)

    def __str__(self):
        return f"RoINode(t={self.time}; pos=[{self.x}, {self.y}]; w={self.width}, h={self.height})"

    def to_dict(self):
        return {
            "time": self.time,
            "pos": {"x": self.x, "y": self.y},
            "size": {"width": self.width, "height": self.height},
        }


class RoIGraph(nx.Graph):
    def __init__(self):
        super().__init__()


class RoIActivity:
    def __init__(
        self,
        graph,
        pointing_diff_th=0.5,
        marking_diff_th=3.0,
        w_range=(0, 1),
        h_range=(0, 1),
        base_size=1,
        data=None,
    ):
        self.graph = graph
        self.pointing_diff_th = pointing_diff_th
        self.marking_diff_th = marking_diff_th
        self.w_range = w_range
        self.h_range = h_range
        self.base_size = base_size
        # Type Identification Parameters
        self.ratio_threshold = 2.5
        self.duration_threshold = 3
        # Initialize
        self.id = uuid.uuid4().hex
        self.x = 0
        self.y = 0
        self.width = 0
        self.height = 0
        self.start = 0
        self.end = 0
        self.type = "none"
        self.data = data or {}
        # Process
        self.metadata = None
        self.components = None
        self._process()

    def _is_valid(self):
        c1 = self.width >= 0 and self.height >= 0
        c2 = self.start <= self.end
        c3 = self.width >= self.w_range[0] and self.width <= self.w_range[1]
        c4 = self.height >= self.h_range[0] and self.height <= self.h_range[1]
        return c1 and c2 and c3 and c4

    def add_data(self, key, value):
        if not self.data:
            self.data = {}
        self.data[key] = value

    def _process(self):
        left, top, right, bottom = float("inf"), float("inf"), 0, 0
        start, end = float("inf"), 0
        for node in self.graph.nodes:
            top = min(top, node.top)
            left = min(left, node.left)
            bottom = max(bottom, node.bottom)
            right = max(right, node.right)
            start = min(start, node.time)
            end = max(end, node.time)
        # Position
        self.x = int(left)
        self.y = int(top)
        self.width = int(right - left)
        self.height = int(bottom - top)
        # Time
        self.start = start
        self.end = end
        # Metadata
        self.metadata = self._capture_metadata()
        # Components
        self.components = self._extract_components()
        # Type
        self.type = self._calc_type()

    def _extract_components(self):
        # Create a subgraph view with a difference threshold
        subgraph = nx.subgraph_view(
            self.graph,
            filter_edge=lambda u, v: self.graph[u][v]["difference"]
            < self.pointing_diff_th,
        )
        # Get connected components
        return list(nx.connected_components(subgraph))

    def _capture_metadata(self):
        # Get the number of nodes in the graph
        node_count = len(self.graph.nodes)
        # Get average difference of the edges in the graph
        difference = 0
        for u, v in self.graph.edges:
            difference += self.graph.edges[u, v]["difference"]
        difference /= len(self.graph.edges) if len(self.graph.edges) > 0 else 1
        # Get ratio between max(width, height) and min(width, height)
        ratio = max(self.width, self.height) / min(self.width, self.height)
        # Get duration of the activity
        duration = self.end - self.start

        metadata = {
            "duration": duration,
            "avg_difference": difference,
            "dim_ratio": ratio,
            "node_count": node_count,
            "rel_size": self.width * self.height / self.base_size,
        }
        return metadata

    def _calc_type(self):
        if not self.metadata:
            self.metadata = self._capture_metadata()

        ratio = self.metadata["dim_ratio"]
        duration = self.metadata["duration"]
        node_count = self.metadata["node_count"]
        difference = self.metadata["avg_difference"]

        # TODO: Maybe improve type recognition in the future.
        if duration == 0:
            return "add_sub"
        if difference <= self.pointing_diff_th:
            return "pointing"
        if difference <= self.marking_diff_th and (
            duration <= self.duration_threshold or ratio >= self.ratio_threshold
        ):
            return "marking"
        if duration <= self.duration_threshold:
            return "animation"
        return "sketching"

    def __eq__(self, other):
        return (
            self.x == other.x
            and self.y == other.y
            and self.width == other.width
            and self.height == other.height
            and self.start == other.start
            and self.end == other.end
        )

    def to_dict(self):
        return {
            "id": self.id,
            "pos": {
                "x": self.x,
                "y": self.y,
            },
            "dim": {
                "width": self.width,
                "height": self.height,
            },
            "start": self.start,
            "end": self.end,
            "type": self.type,
            "is_valid": self._is_valid(),
            "components": [
                {
                    "count": len(component),
                    "nodes": [node.to_dict() for node in component],
                }
                for component in self.components
            ],
            "metadata": {**self.metadata, **self.data},
        }
