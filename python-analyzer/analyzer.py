# Copyright (C) 2026 Yotam Sechayk
# SPDX-License-Identifier: AGPL-3.0-or-later

import os
import uuid
import cv2
import json
import numpy as np
from tqdm import tqdm
from roi import RoIGraph, RoINode, RoIActivity
from scenedetect import detect, ContentDetector
import networkx as nx


class VideoAnalyzer:
    def __init__(
        self,
        video_path,
        sample_fps_ratio=0.5,
        contour_area_low=0.00015,
        contour_area_high=0.5,
        roi_distance_ratio=0.05,
        roi_area_low=0.01,
        roi_area_high=0.7,
        roi_timespan_th=1.5,
        diff_pointing_th=0.5,
        diff_marking_th=3,
    ):
        self.file_path = video_path
        # File properties
        self.file_name = os.path.basename(self.file_path)
        self.file_size = os.path.getsize(self.file_path)
        self.file_extension = os.path.splitext(self.file_path)[1]
        # Video properties
        cap = cv2.VideoCapture(self.file_path)
        if cap.isOpened():
            self.dimensions = (
                int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            )
            self.frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            self.fps = cap.get(cv2.CAP_PROP_FPS)
            self.duration = self.frames / self.fps
            cap.release()
        # Analysis parameters
        self.sample_fps_ratio = sample_fps_ratio
        self.contour_area_low = contour_area_low
        self.contour_area_high = contour_area_high
        self.roi_area_low = roi_area_low
        self.roi_area_high = roi_area_high
        self.roi_timespan_th = roi_timespan_th
        self.roi_distance_ratio = roi_distance_ratio
        self.diff_pointing_th = diff_pointing_th
        self.diff_marking_th = diff_marking_th
        vw, vh = self.dimensions
        self.roi_distance_th = int(((vw**2 + vh**2) ** 0.5) * self.roi_distance_ratio)
        # Other
        self.epsilon = 1e-3

    def _detect_scenes(self):
        scene_list = detect(
            self.file_path, ContentDetector(threshold=14), start_in_scene=True
        )
        result = []
        for i, scene in enumerate(scene_list):
            result.append(
                {
                    "start": scene[0].get_seconds(),
                    "end": scene[1].get_seconds(),
                }
            )
        return result

    def _get_frame_pairs(self, start, end):
        frame_pairs = []
        fps = self.fps
        fstart = int(start * fps)
        fend = int(end * fps)
        span = int(fps * self.sample_fps_ratio)
        for i in range(fstart, fend - span, span):
            frame_pairs.append((i, i + int(fps * self.sample_fps_ratio)))

        return frame_pairs

    def _detect_contours(self, frame1, frame2):
        assert frame1.shape == frame2.shape, "Frames must have the same dimensions."

        # Get the absolute difference between the two frames
        diff = cv2.absdiff(frame1, frame2)
        gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
        blur = cv2.GaussianBlur(gray, (5, 5), 0)
        # Threshold the difference image to get the foreground mask
        _, thresh = cv2.threshold(blur, 25, 255, cv2.THRESH_BINARY)
        dilated = cv2.dilate(thresh, None, iterations=3)
        # Find contours in the dilated image
        contours, _ = cv2.findContours(dilated, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

        return contours, (diff, gray, blur, thresh, dilated)

    def _contours_to_roi_nodes(self, contours, time):
        vw, vh = self.dimensions
        nodes = []
        for i, contour in enumerate(contours):
            (x, y, width, height) = cv2.boundingRect(contour)
            # Filter out small contours (noise)
            if width * height < self.contour_area_low * vw * vh:
                continue
            if vw * vh * self.contour_area_high < width * height:
                continue
            # Create a bitmap of the contour for visualization
            bitmap = np.zeros((height, width), dtype=np.uint8)
            shifted = [[p[0][0] - x, p[0][1] - y] for p in contour]
            cv2.drawContours(bitmap, [np.array(shifted)], -1, 255, -1)
            # Create a RoINode for the contour
            nodes.append(
                RoINode(
                    time,
                    x,
                    y,
                    width,
                    height,
                    {"size": len(contour), "contour": contour, "bitmap": bitmap},
                )
            )
        return nodes

    def _gen_roi_graph(self, nodes):
        # Add all nodes to the graph
        graph = RoIGraph()
        for n in nodes:
            graph.add_node(n)

        # Add edges between nodes if they fit the criteria
        sorted_nodes = sorted(nodes, key=lambda x: x.time)
        for i, node in tqdm(
            enumerate(sorted_nodes), desc="Generating RoI Graph", total=len(graph.nodes)
        ):
            for j, other in enumerate(sorted_nodes):
                distance = node.distance(other)
                span = node.span(other)
                if i >= j:
                    continue
                if span >= self.roi_timespan_th:
                    continue
                if distance >= self.roi_distance_th:
                    continue

                difference = cv2.matchShapes(
                    node.data["contour"],
                    other.data["contour"],
                    cv2.CONTOURS_MATCH_I2,
                    0,
                )
                graph.add_edge(
                    node, other, difference=difference, distance=distance, span=span
                )
        # Contract edges with zero distance and small span.
        # This merges nodes that are relatively the same in two consecutive frames.
        # (Removes duplication of cursor movements).
        keep_merging = True
        while not keep_merging:
            keep_merging = False
            for u, v, data in graph.edges.data():
                if (
                    data["distance"] < self.epsilon
                    and data["span"] < self.sample_fps_ratio + self.epsilon
                    and data["difference"] < self.diff_pointing_th
                ):
                    if u.time < v.time:
                        u, v = v, u
                    graph = nx.contracted_nodes(graph, u, v, self_loops=False)
                    keep_merging = True
                    break

        return graph

    def _get_roi_activities(self, graph):
        activities = []
        vw, vh = self.dimensions
        for component in nx.connected_components(graph):
            subgraph = graph.subgraph(component)
            activity = RoIActivity(
                subgraph,
                pointing_diff_th=self.diff_pointing_th,
                marking_diff_th=self.diff_marking_th,
                w_range=(self.roi_area_low * vw, self.roi_area_high * vw),
                h_range=(self.roi_area_low * vh, self.roi_area_high * vh),
                base_size=vw * vh,
            )
            activities.append(activity)
        return activities

    def analyze(self):
        """
        Analyze the video file.
        """
        # Open video file
        t0 = cv2.getTickCount()

        scene_list = self._detect_scenes()
        frame_pairs = []
        for scene in scene_list:
            frame_pairs.extend(self._get_frame_pairs(scene["start"], scene["end"]))
        cap = cv2.VideoCapture(self.file_path)
        if not cap.isOpened():
            raise Exception("Error opening video file.")

        metadata = {
            "fps": self.fps,
            "frames": self.frames,
            "duration": self.duration,
            "dim": {
                "width": self.dimensions[0],
                "height": self.dimensions[1],
            },
            "sample_fps_ratio": self.sample_fps_ratio,
            "contour_area_low": self.contour_area_low,
            "contour_area_high": self.contour_area_high,
            "roi_distance_ratio": self.roi_distance_ratio,
            "roi_distance_th": self.roi_distance_th,
            "roi_span_th": self.roi_timespan_th,
            "roi_area_low": self.roi_area_low,
            "roi_area_high": self.roi_area_high,
            "diff_pointing_th": self.diff_pointing_th,
            "diff_marking_th": self.diff_marking_th,
        }

        nodes = []
        for i, (start, end) in tqdm(
            enumerate(frame_pairs), desc="Extracting RoI Nodes", total=len(frame_pairs)
        ):
            start = max(0, start)
            end = min(end, self.frames - 1)

            cap.set(cv2.CAP_PROP_POS_FRAMES, start)
            ret1, frame1 = cap.read()
            cap.set(cv2.CAP_PROP_POS_FRAMES, end)
            ret2, frame2 = cap.read()
            assert ret1 and ret2, "Error reading frames from video."

            contours, _ = self._detect_contours(frame1, frame2)
            ftime = start / self.fps
            nodes.extend(self._contours_to_roi_nodes(contours, ftime))
        # Frames are all read; the graph and activity passes below don't touch the capture.
        cap.release()

        graph = self._gen_roi_graph(nodes)
        activities = self._get_roi_activities(graph)

        t1 = cv2.getTickCount()
        analysis_time = (t1 - t0) / cv2.getTickFrequency()

        return {
            "id": uuid.uuid4().hex,
            "name": self.file_name,
            "filesize": self.file_size,
            "extension": self.file_extension,
            "metadata": {
                **metadata,
                "analysis_time": analysis_time,
            },
            "scenes": scene_list,
            "activities": [
                {"ord": i, **activity.to_dict()}
                for i, activity in enumerate(activities)
            ],
        }

    def visualize(self, analysis, fname="output.mp4"):
        """
        Visualize the analysis result on the video and export it as a new video file.
        Using OpenCV to draw the RoI nodes and activities on the video.
        Export using moviepy.
        """
        # TODO: Currently this function might not be working, need to verify.
        # moviepy is imported here, not at module load, so the core analysis pipeline
        # doesn't drag in moviepy/ffmpeg just to produce JSON.
        import moviepy.editor as mpy

        cap = cv2.VideoCapture(self.file_path)
        fps = self.fps

        frames = []
        # Read each frame from the video
        if not cap.isOpened():
            raise Exception("Error opening video file.")

        for i in tqdm(range(self.frames), desc="Visualizing"):
            ret, frame = cap.read()
            if not ret:
                break

            # Get current frame time
            time = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0

            # Draw the RoI nodes and activities on the frame
            for activity in analysis["activities"]:
                x = activity["pos"]["x"]
                y = activity["pos"]["y"]
                width = activity["dim"]["width"]
                height = activity["dim"]["height"]
                start = activity["start"]
                end = activity["end"]
                type = activity["type"]
                if time >= start and time <= end:
                    cv2.rectangle(
                        frame,
                        (x - 2, y - 2),
                        (x + width + 2, y + height + 2),
                        (0, 255, 0),
                        2,
                    )
                    # Place 'type' text on top the frame, with black rectangle background
                    cv2.rectangle(
                        frame,
                        (x, y - 30),
                        (x + 150, y),
                        (0, 0, 0),
                        -1,
                    )
                    cv2.putText(
                        frame,
                        type,
                        (x, y - 5),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.75,
                        (255, 255, 255),
                        1,
                    )
                    for component in activity["components"]:
                        for node in component["nodes"]:
                            x = node["pos"]["x"]
                            y = node["pos"]["y"]
                            w = node["size"]["width"]
                            h = node["size"]["height"]
                            t = node["time"]
                            if time >= t:
                                cv2.rectangle(
                                    frame, (x, y), (x + w, y + h), (0, 0, 255), 2
                                )
            frames.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        cap.release()

        # Export the frames as a new video file using moviepy
        clip = mpy.ImageSequenceClip(frames, fps=fps)
        clip.write_videofile(fname)
        frames.clear()
        clip.close()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Detect instructor activity (pointing, marking, sketching) in a "
        "slide-based lecture video and write the results as JSON."
    )
    parser.add_argument("video", help="path to the lecture video file")
    parser.add_argument(
        "-o",
        "--output",
        default="analysis.json",
        help="output JSON path (default: analysis.json)",
    )
    args = parser.parse_args()

    analyzer = VideoAnalyzer(args.video)
    analysis = analyzer.analyze()
    with open(args.output, "w") as f:
        json.dump(analysis, f, indent=4)
    print(f"Wrote {args.output}")
