/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  bufferFromFileOrString,
  Cluster,
  Config,
  CoreV1Api,
  KubeConfig,
  Metrics,
  topPods,
  User,
  V1Pod,
} from '@kubernetes/client-node';
import lodash, { Dictionary } from 'lodash';
import { Logger } from 'winston';
import {
  ClusterDetails,
  FetchResponseWrapper,
  KubernetesFetcher,
  ObjectFetchParams,
  PodLog,
  PodLogUrl,
} from '../types/types';
import {
  FetchResponse,
  KubernetesErrorTypes,
  KubernetesFetchError,
  PodStatusFetchResponse,
} from '@backstage/plugin-kubernetes-common';
import fetch, { RequestInit, Response } from 'node-fetch';
import * as https from 'https';
import fs from 'fs-extra';

export interface KubernetesClientBasedFetcherOptions {
  logger: Logger;
}

type FetchResult = FetchResponse | KubernetesFetchError;

const isError = (fr: FetchResult): fr is KubernetesFetchError =>
  fr.hasOwnProperty('errorType');

function fetchResultsToResponseWrapper(
  results: FetchResult[],
): FetchResponseWrapper {
  const groupBy: Dictionary<FetchResult[]> = lodash.groupBy(results, value => {
    return isError(value) ? 'errors' : 'responses';
  });

  return {
    errors: groupBy.errors ?? [],
    responses: groupBy.responses ?? [],
  } as FetchResponseWrapper; // TODO would be nice to get rid of this 'as'
}

const statusCodeToErrorType = (statusCode: number): KubernetesErrorTypes => {
  switch (statusCode) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED_ERROR';
    case 404:
      return 'NOT_FOUND';
    case 500:
      return 'SYSTEM_ERROR';
    default:
      return 'UNKNOWN_ERROR';
  }
};

export class KubernetesClientBasedFetcher implements KubernetesFetcher {
  private readonly logger: Logger;

  constructor({ logger }: KubernetesClientBasedFetcherOptions) {
    this.logger = logger;
  }

  fetchObjectsForService(
    params: ObjectFetchParams,
  ): Promise<FetchResponseWrapper> {
    const fetchResults = Array.from(params.objectTypesToFetch)
      .concat(params.customResources)
      .map(({ objectType, group, apiVersion, plural }) =>
        this.fetchResource(
          params.clusterDetails,
          group,
          apiVersion,
          plural,
          params.namespace,
          params.labelSelector ||
            `backstage.io/kubernetes-id=${params.serviceId}`,
        ).then(
          (r: Response): Promise<FetchResult> =>
            r.ok
              ? r.json().then(
                  ({ items }): FetchResponse => ({
                    type: objectType,
                    resources: items,
                  }),
                )
              : this.handleUnsuccessfulResponse(params.clusterDetails.name, r),
        ),
      );

    return Promise.all(fetchResults).then(fetchResultsToResponseWrapper);
  }

  fetchPodMetricsByNamespaces(
    clusterDetails: ClusterDetails,
    namespaces: Set<string>,
  ): Promise<FetchResponseWrapper> {
    const fetchResults = Array.from(namespaces).map(async ns => {
      const [podMetrics, podList] = await Promise.all([
        this.fetchResource(
          clusterDetails,
          'metrics.k8s.io',
          'v1beta1',
          'pods',
          ns,
        ),
        this.fetchResource(clusterDetails, '', 'v1', 'pods', ns),
      ]);
      if (podMetrics.ok && podList.ok) {
        return topPods(
          {
            listPodForAllNamespaces: () =>
              podList.json().then(b => ({ body: b })),
          } as unknown as CoreV1Api,
          {
            getPodMetrics: () => podMetrics.json(),
          } as unknown as Metrics,
        ).then(
          (resources): PodStatusFetchResponse => ({
            type: 'podstatus',
            resources,
          }),
        );
      } else if (podMetrics.ok) {
        return this.handleUnsuccessfulResponse(clusterDetails.name, podList);
      }
      return this.handleUnsuccessfulResponse(clusterDetails.name, podMetrics);
    });

    return Promise.all(fetchResults).then(fetchResultsToResponseWrapper);
  }

  fetchPodLogs(
    clusterDetails: ClusterDetails,
    pods: V1Pod[],
  ): Promise<PodLog[]> {
    const podContainerMap: PodLog[] = [];

    pods.forEach(x => {
      x.spec?.containers?.forEach(y => {
        podContainerMap.push({
          name: x.metadata?.name ?? 'default',
          namespace: x.metadata?.namespace ?? 'default',
          container: y.name,
          logs: '',
        });
      });
    });

    const fetchResults = podContainerMap.map(map => {
      return this.fetchLogs(
        clusterDetails,
        map.namespace ?? 'default',
        map.name ?? 'default',
        map.container,
      ).then(async logs => {
        return {
          name: map.name,
          container: map.container,
          namespace: map.namespace,
          log: logs.ok ? await logs.text() : '',
        } as unknown as PodLog;
      });
    });

    return Promise.all(fetchResults);
  }

  getPodLogsUrl(clusterDetails: ClusterDetails, pods: V1Pod[]): PodLogUrl[] {
    const podContainerMap: PodLogUrl[] = [];

    pods.forEach(x => {
      x.spec?.containers?.forEach(y => {
        const [url, init] = this.getPodContianerLogEndpointWithAuth(
          clusterDetails,
          x.metadata?.name ?? '',
          x.metadata?.namespace ?? 'default',
          y.name,
        );
        podContainerMap.push({
          name: x.metadata?.name ?? '',
          namespace: x.metadata?.namespace ?? 'default',
          container: y.name,
          url: url.toString(),
          requestInit: init,
        });
      });
    });

    return podContainerMap;
  }

  private async handleUnsuccessfulResponse(
    clusterName: string,
    res: Response,
  ): Promise<KubernetesFetchError> {
    const resourcePath = new URL(res.url).pathname;
    this.logger.warn(
      `Received ${
        res.status
      } status when fetching "${resourcePath}" from cluster "${clusterName}"; body=[${await res.text()}]`,
    );
    return {
      errorType: statusCodeToErrorType(res.status),
      statusCode: res.status,
      resourcePath,
    };
  }

  private fetchResource(
    clusterDetails: ClusterDetails,
    group: string,
    apiVersion: string,
    plural: string,
    namespace?: string,
    labelSelector?: string,
  ): Promise<Response> {
    const encode = (s: string) => encodeURIComponent(s);
    let resourcePath = group
      ? `/apis/${encode(group)}/${encode(apiVersion)}`
      : `/api/${encode(apiVersion)}`;
    if (namespace) {
      resourcePath += `/namespaces/${encode(namespace)}`;
    }
    resourcePath += `/${encode(plural)}`;

    let url: URL;
    let requestInit: RequestInit;
    if (clusterDetails.serviceAccountToken) {
      [url, requestInit] = this.fetchArgsFromClusterDetails(clusterDetails);
    } else if (fs.pathExistsSync(Config.SERVICEACCOUNT_TOKEN_PATH)) {
      [url, requestInit] = this.fetchArgsInCluster();
    } else {
      return Promise.reject(
        new Error(
          `no bearer token for cluster '${clusterDetails.name}' and not running in Kubernetes`,
        ),
      );
    }

    url.pathname = resourcePath;
    if (labelSelector) {
      url.search = `labelSelector=${labelSelector}`;
    }

    return fetch(url, requestInit);
  }

  private getPodContianerLogEndpointWithAuth(
    clusterDetails: ClusterDetails,
    namespace: string,
    pod: string,
    container: string,
  ): [URL, RequestInit] {
    const encode = (s: string) => encodeURIComponent(s);
    const resourcePath = `/api/v1/namespaces/${encode(namespace)}/pods/${encode(
      pod,
    )}/log`;
    let url: URL;
    let requestInit: RequestInit;
    if (clusterDetails.serviceAccountToken) {
      [url, requestInit] = this.fetchArgsFromClusterDetails(clusterDetails);
    } else if (fs.pathExistsSync(Config.SERVICEACCOUNT_TOKEN_PATH)) {
      [url, requestInit] = this.fetchArgsInCluster();
    } else {
      throw new Error(
        `no bearer token for cluster '${clusterDetails.name}' and not running in Kubernetes`,
      );
    }

    url.pathname = resourcePath;
    url.searchParams.append('container', container);
    url.searchParams.append('tailLines', '100');

    return [url, requestInit];
  }

  private fetchLogs(
    clusterDetails: ClusterDetails,
    namespace: string,
    pod: string,
    container: string,
  ): Promise<Response> {
    const [url, requestInit] = this.getPodContianerLogEndpointWithAuth(
      clusterDetails,
      namespace,
      pod,
      container,
    );

    return fetch(url, requestInit);
  }

  private fetchArgsFromClusterDetails(
    clusterDetails: ClusterDetails,
  ): [URL, RequestInit] {
    const requestInit: RequestInit = {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clusterDetails.serviceAccountToken}`,
      },
    };

    const url: URL = new URL(clusterDetails.url);
    if (url.protocol === 'https:') {
      requestInit.agent = new https.Agent({
        ca:
          bufferFromFileOrString(
            clusterDetails.caFile,
            clusterDetails.caData,
          ) ?? undefined,
        rejectUnauthorized: !clusterDetails.skipTLSVerify,
      });
    }
    return [url, requestInit];
  }
  private fetchArgsInCluster(): [URL, RequestInit] {
    const kc = new KubeConfig();
    kc.loadFromCluster();
    // loadFromCluster is guaranteed to populate the cluster/user/context
    const cluster = kc.getCurrentCluster() as Cluster;
    const user = kc.getCurrentUser() as User;

    const token = fs.readFileSync(user.authProvider.config.tokenFile);

    const requestInit: RequestInit = {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    };

    const url = new URL(cluster.server);
    if (url.protocol === 'https:') {
      requestInit.agent = new https.Agent({
        ca: fs.readFileSync(cluster.caFile as string),
      });
    }
    return [url, requestInit];
  }
}
