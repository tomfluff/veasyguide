// Ported from VeasyGuide unchanged (Container/Stack wrappers trimmed).
import { Grid, Slider, Title, Space, Switch, Button, Group } from "@mantine/core";
import {
  useMagnificationSettingsStore,
  setMagnificationSettings,
  filterStyleOptions,
  type TFilterStyle,
} from "../stores/MagnificationSettingsStore";
import { convertToTitleCase } from "../utils/misc";

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
        <Title order={6}>Filter</Title>
      </Grid.Col>
      <Grid.Col span={8}>
        <Group gap="xs">
          {filterStyleOptions.map((option) => (
            <Button
              key={option}
              variant="filled"
              size="xs"
              px={6}
              py={0}
              color={
                settingsStore.filter_style.includes(option as TFilterStyle)
                  ? "blue"
                  : "gray"
              }
              onClick={() =>
                setMagnificationSettings({
                  filter_style: settingsStore.filter_style.includes(
                    option as TFilterStyle
                  )
                    ? settingsStore.filter_style.filter((f) => f !== option)
                    : [...settingsStore.filter_style, option as TFilterStyle].sort(
                        (a, b) =>
                          filterStyleOptions.indexOf(a) - filterStyleOptions.indexOf(b)
                      ),
                })
              }
            >
              {convertToTitleCase(option)}
            </Button>
          ))}
        </Group>
      </Grid.Col>
      <Grid.Col span={4}>
        <Title order={6}>Sharpen</Title>
      </Grid.Col>
      <Grid.Col span={8}>
        <Slider
          label={`${settingsStore.sharpness - 1.0}x`}
          min={1}
          max={2}
          step={0.25}
          marks={[
            { value: 1, label: "None" },
            { value: 1.5, label: "0.5x" },
            { value: 2, label: "1x" },
          ]}
          value={settingsStore.sharpness}
          onChange={(value) => setMagnificationSettings({ sharpness: value })}
        />
        <Space h="lg" />
      </Grid.Col>
    </Grid>
  );
};

export default MagnificationOverlaySettings;
