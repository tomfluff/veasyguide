// Ported from VeasyGuide unchanged (Container/Stack wrappers trimmed).
import { Stack, Grid, Slider, Text, Title, Space, Switch, Button, Group } from "@mantine/core";
import {
  useMagnificationSettingsStore,
  setMagnificationSettings,
  filterStyleOptions,
} from "../stores/MagnificationSettingsStore";
import { filterStyleLabels } from "../stores/HighlightSettingsStore";

const MagnificationOverlaySettings = () => {
  const settingsStore = useMagnificationSettingsStore();

  return (
    <Grid align="center" gutter="md">
      <Grid.Col span={4}>
        <Title order={6}>Strength</Title>
      </Grid.Col>
      <Grid.Col span={8}>
        <Slider
          label={`${1 + settingsStore.zoom_strength}x`}
          min={0}
          max={1}
          step={0.05}
          marks={[
            { value: 0, label: "0%" },
            { value: 0.25, label: "25%" },
            { value: 0.5, label: "50%" },
            { value: 0.75, label: "75%" },
            { value: 1, label: "100%" },
          ]}
          value={settingsStore.zoom_strength}
          onChange={(value) => setMagnificationSettings({ zoom_strength: value })}
        />
        <Space h="md" />
      </Grid.Col>
      <Grid.Col span={4}>
        <Title order={6}>Speed</Title>
      </Grid.Col>
      <Grid.Col span={8}>
        <Slider
          label={`${settingsStore.zoom_speed}x`}
          min={0.1}
          max={2}
          step={0.1}
          marks={[
            { value: 0.1, label: "0.1x" },
            { value: 0.5, label: "0.5x" },
            { value: 1, label: "1x" },
            { value: 2, label: "2x" },
          ]}
          value={settingsStore.zoom_speed}
          onChange={(value) => setMagnificationSettings({ zoom_speed: value })}
        />
        <Space h="md" />
      </Grid.Col>
      <Grid.Col span={10}>
        <Title order={6}>Pause video on zoom</Title>
      </Grid.Col>
      <Grid.Col span={2}>
        <Switch
          checked={settingsStore.pause_on_zoom}
          onChange={(event) =>
            setMagnificationSettings({ pause_on_zoom: event.target.checked })
          }
        />
      </Grid.Col>
      <Grid.Col span={4}>
        <Title order={6}>Enhance</Title>
      </Grid.Col>
      <Grid.Col span={8}>
<Stack gap={6}>
  {filterStyleOptions.map((option) => {
    const on = settingsStore.filter_style.includes(option);
    return (
      <Group key={option} gap="xs" wrap="nowrap" align="center">
        <Button
          variant={on ? "filled" : "default"}
          size="xs"
          px={8}
          py={0}
          style={{ flex: "none", minWidth: 184 }}
          aria-pressed={on}
          onClick={() =>
            setMagnificationSettings({
              filter_style: on
                ? settingsStore.filter_style.filter((f) => f !== option)
                : [...settingsStore.filter_style, option].sort(
                    (a, b) =>
                      filterStyleOptions.indexOf(a) -
                      filterStyleOptions.indexOf(b)
                  ),
            })
          }
        >
          {filterStyleLabels[option].label}
        </Button>
        {/* Visible, not a tooltip. This is the ONLY explanation of what the
            filter does, and a hover tooltip hides it from every keyboard and
            screen-reader user — the audience. */}
        <Text size="xs" c="dimmed">
          {filterStyleLabels[option].hint}
        </Text>
      </Group>
    );
  })}
</Stack>
      </Grid.Col>
      <Grid.Col span={4}>
        <Title order={6}>Contrast</Title>
      </Grid.Col>
      <Grid.Col span={8}>
        <Slider
          label={`${settingsStore.contrast.toFixed(2)}×`}
          min={1}
          max={2}
          step={0.05}
          marks={[
            { value: 1, label: "None" },
            { value: 1.5, label: "1.5×" },
            { value: 2, label: "2×" },
          ]}
          value={settingsStore.contrast}
          onChange={(value) => setMagnificationSettings({ contrast: value })}
        />
        <Space h="lg" />
      </Grid.Col>
    </Grid>
  );
};

export default MagnificationOverlaySettings;
